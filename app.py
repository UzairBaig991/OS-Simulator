
from flask import Flask, render_template, jsonify, request
import psutil
import time

app = Flask(__name__)
start_time = time.time()
AGING_INTERVAL = 2
MAX_PROCESSES = 12
MAX_TOTAL_BURST = 500
SAMPLE_JOBS = [
    {"name": "Process A", "arrival": 0, "burst": 8, "priority": 3},
    {"name": "Process B", "arrival": 1, "burst": 4, "priority": 1},
    {"name": "Process C", "arrival": 2, "burst": 9, "priority": 4},
    {"name": "Process D", "arrival": 3, "burst": 5, "priority": 2}
]


def parse_jobs(value):
    if value is None:
        return [job.copy() for job in SAMPLE_JOBS]
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_PROCESSES:
        raise ValueError(f"Workload must contain between 1 and {MAX_PROCESSES} processes.")

    jobs = []
    names = set()
    total_burst = 0
    for index, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"Process {index} must be an object.")
        name = item.get("name")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 24:
            raise ValueError(f"Process {index} needs a name of 1–24 characters.")
        name = name.strip()
        if name.casefold() in names:
            raise ValueError("Process names must be unique.")
        names.add(name.casefold())

        process = {"name": name}
        for field, minimum, maximum in (
            ("arrival", 0, 10000),
            ("burst", 1, MAX_TOTAL_BURST),
            ("priority", 1, 10)
        ):
            number = item.get(field)
            if isinstance(number, bool) or not isinstance(number, int):
                raise ValueError(f"{name}: {field} must be a whole number.")
            if not minimum <= number <= maximum:
                raise ValueError(f"{name}: {field} must be between {minimum} and {maximum}.")
            process[field] = number
        total_burst += process["burst"]
        jobs.append(process)

    if total_burst > MAX_TOTAL_BURST:
        raise ValueError(f"Total burst time cannot exceed {MAX_TOTAL_BURST} units.")
    return jobs


def schedule_jobs(jobs, algorithm, quantum):
    pending = sorted(enumerate(jobs), key=lambda item: (item[1]["arrival"], item[0]))
    remaining = [job["burst"] for job in jobs]
    first_start = [None] * len(jobs)
    completion = [None] * len(jobs)
    timeline = []
    ready = []
    clock = 0.0

    def add_arrivals():
        while pending and pending[0][1]["arrival"] <= clock:
            ready.append(pending.pop(0)[0])

    def effective_priority(index):
        executed = jobs[index]["burst"] - remaining[index]
        waiting = clock - jobs[index]["arrival"] - executed
        return max(0, jobs[index]["priority"] - int(waiting // AGING_INTERVAL))

    def record(index, duration):
        nonlocal clock
        if first_start[index] is None:
            first_start[index] = clock
        if timeline and timeline[-1]["name"] == jobs[index]["name"]:
            timeline[-1]["duration"] = round(timeline[-1]["duration"] + duration, 6)
        else:
            timeline.append({
                "name": jobs[index]["name"],
                "start": round(clock, 6),
                "duration": round(duration, 6)
            })
        remaining[index] = round(remaining[index] - duration, 6)
        clock = round(clock + duration, 6)
        if remaining[index] <= 0.000001:
            remaining[index] = 0
            completion[index] = clock

    if algorithm == "Round Robin":
        queue = []
        time_slice = quantum / 100
        while pending or queue:
            while pending and pending[0][1]["arrival"] <= clock:
                queue.append(pending.pop(0)[0])
            if not queue:
                clock = float(pending[0][1]["arrival"])
                continue
            index = queue.pop(0)
            duration = min(time_slice, remaining[index])
            record(index, duration)
            while pending and pending[0][1]["arrival"] <= clock:
                queue.append(pending.pop(0)[0])
            if remaining[index] > 0:
                queue.append(index)
    else:
        while pending or ready:
            add_arrivals()
            if not ready:
                clock = float(pending[0][1]["arrival"])
                continue

            if algorithm in {"SJF", "SRTF"}:
                index = min(ready, key=lambda i: (remaining[i], jobs[i]["arrival"], i))
            elif algorithm in {"Priority", "Priority Preemptive"}:
                index = min(ready, key=lambda i: (jobs[i]["priority"], jobs[i]["arrival"], i))
            elif algorithm == "Aging":
                index = min(ready, key=lambda i: (effective_priority(i), jobs[i]["arrival"], i))
            else:
                index = ready[0]
            ready.remove(index)

            if algorithm in {"SRTF", "Priority Preemptive"}:
                duration = remaining[index]
                if pending:
                    duration = min(duration, pending[0][1]["arrival"] - clock)
                record(index, duration)
                add_arrivals()
                if remaining[index] > 0:
                    ready.append(index)
            else:
                record(index, remaining[index])
                add_arrivals()

    results = []
    for index, job in enumerate(jobs):
        turnaround = completion[index] - job["arrival"]
        waiting = turnaround - job["burst"]
        response = first_start[index] - job["arrival"]
        results.append({
            **job,
            "waiting": round(waiting, 2),
            "turnaround": round(turnaround, 2),
            "response": round(response, 2),
            "completion": round(completion[index], 2)
        })

    finish_time = max(completion)
    total_burst = sum(job["burst"] for job in jobs)
    return {
        "algorithm": algorithm,
        "results": results,
        "average_waiting": round(sum(result["waiting"] for result in results) / len(results), 2),
        "average_response": round(sum(result["response"] for result in results) / len(results), 2),
        "average_turnaround": round(sum(result["turnaround"] for result in results) / len(results), 2),
        "cpu_utilization": round(total_burst / finish_time * 100, 2) if finish_time else 0,
        "throughput": round(len(jobs) / finish_time, 3) if finish_time else 0,
        "timeline": timeline
    }


@app.route("/")
def dashboard():
    return render_template("index.html", aging_interval=AGING_INTERVAL)


@app.route("/api/stats")
def stats():
    memory = psutil.virtual_memory()
    boot_time = psutil.boot_time()

    return jsonify({
        "cpu": psutil.cpu_percent(interval=0.2),
        "memory": memory.percent,
        "total_memory": round(memory.total / (1024 ** 3), 2),
        "used_memory": round(memory.used / (1024 ** 3), 2),
        "processes": len(psutil.pids()),
        "uptime": int(time.time() - boot_time)
    })


@app.route("/api/processes")
def processes():
    result = []

    for process in psutil.process_iter(
        ["pid", "name", "memory_percent", "status"]
    ):
        try:
            item = process.info
            result.append({
                "pid": item["pid"],
                "name": item["name"] or "Unknown",
                "memory": round(item["memory_percent"] or 0, 2),
                "status": item["status"] or "Unknown"
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    return jsonify(sorted(result, key=lambda p: p["memory"], reverse=True)[:10])


@app.route("/api/simulate", methods=["POST"])
def simulate():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Expected a JSON object."}), 400

    algorithm = data.get("algorithm", "Round Robin")
    if not isinstance(algorithm, str) or algorithm not in {
        "FCFS", "SJF", "SRTF", "Priority", "Priority Preemptive",
        "Aging", "Round Robin"
    }:
        return jsonify({"error": "Choose a supported scheduling algorithm."}), 400
    try:
        quantum_value = data.get("quantum", 100)
        if isinstance(quantum_value, bool):
            raise ValueError
        quantum = int(quantum_value)
        if isinstance(quantum_value, float) and not quantum_value.is_integer():
            raise ValueError
        quantum = max(1, min(quantum, 10000))
    except (TypeError, ValueError):
        return jsonify({"error": "Time quantum must be a whole number."}), 400

    try:
        jobs = parse_jobs(data.get("jobs"))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    return jsonify(schedule_jobs(jobs, algorithm, quantum))


if __name__ == "__main__":
    app.run(debug=True)

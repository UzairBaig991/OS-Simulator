
from flask import Flask, render_template, jsonify, request
import psutil
import time

app = Flask(__name__)
start_time = time.time()
AGING_INTERVAL = 2


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
        "FCFS", "SJF", "Priority", "Aging", "Round Robin"
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

    # Sample jobs: (name, arrival time, burst time, priority)
    jobs = [
        {"name": "Process A", "arrival": 0, "burst": 8, "priority": 3},
        {"name": "Process B", "arrival": 1, "burst": 4, "priority": 1},
        {"name": "Process C", "arrival": 2, "burst": 9, "priority": 4},
        {"name": "Process D", "arrival": 3, "burst": 5, "priority": 2}
    ]

    remaining = {j["name"]: j["burst"] for j in jobs}
    completion = {}
    timeline = []
    clock = 0

    if algorithm == "Round Robin":
        queue = []
        pending = sorted(jobs, key=lambda j: j["arrival"])
        while pending or queue:
            while pending and pending[0]["arrival"] <= clock:
                queue.append(pending.pop(0))
            if not queue:
                clock = pending[0]["arrival"]
                continue

            job = queue.pop(0)
            name = job["name"]
            run = min(quantum / 100, remaining[name])
            timeline.append({"name": name, "start": clock, "duration": run})
            clock += run
            remaining[name] -= run

            while pending and pending[0]["arrival"] <= clock:
                queue.append(pending.pop(0))

            if remaining[name] > 0:
                queue.append(job)
            else:
                completion[name] = clock

    else:
        pending = sorted(jobs, key=lambda j: j["arrival"])
        ready = []
        while pending or ready:
            while pending and pending[0]["arrival"] <= clock:
                ready.append(pending.pop(0))
            if not ready:
                clock = pending[0]["arrival"]
                continue

            if algorithm == "SJF":
                job = min(ready, key=lambda j: j["burst"])
            elif algorithm == "Priority":
                job = min(ready, key=lambda j: j["priority"])
            elif algorithm == "Aging":
                job = min(
                    ready,
                    key=lambda j: (
                        max(
                            0,
                            j["priority"] - int(
                                (clock - j["arrival"]) // AGING_INTERVAL
                            )
                        ),
                        j["arrival"]
                    )
                )
            else:
                job = ready[0]  # FCFS
            ready.remove(job)

            name = job["name"]
            run = remaining[name]
            timeline.append({"name": name, "start": clock, "duration": run})
            clock += run
            remaining[name] = 0
            completion[name] = clock

    results = []
    for job in jobs:
        turnaround = completion[job["name"]] - job["arrival"]
        waiting = turnaround - job["burst"]
        results.append({
            "name": job["name"],
            "burst": job["burst"],
            "waiting": round(waiting, 2),
            "turnaround": round(turnaround, 2)
        })

    return jsonify({
        "algorithm": algorithm,
        "results": results,
        "average_waiting": round(sum(r["waiting"] for r in results) / len(results), 2),
        "timeline": timeline
    })


if __name__ == "__main__":
    app.run(debug=True)

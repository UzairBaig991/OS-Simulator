
from flask import Flask, render_template, jsonify, request
import psutil
import time
import os
import platform
import math

app = Flask(__name__)
start_time = time.time()
CPU_COUNT = psutil.cpu_count() or 1
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

    if algorithm == "MLFQ":
        queues = [[], [], []]
        base_quantum = quantum / 100
        boost_interval = base_quantum * 8
        next_boost = boost_interval

        def admit_mlfq():
            while pending and pending[0][1]["arrival"] <= clock:
                queues[0].append(pending.pop(0)[0])

        while pending or any(queues):
            admit_mlfq()
            if clock >= next_boost:
                next_boost += (math.floor((clock - next_boost) / boost_interval) + 1) * boost_interval
                queues[0] = queues[0] + queues[1] + queues[2]
                queues[1], queues[2] = [], []
            if not any(queues):
                clock = float(pending[0][1]["arrival"])
                continue

            level = next(index for index, queue in enumerate(queues) if queue)
            index = queues[level].pop(0)
            quantum_limit = base_quantum * (2 ** level)
            boost_limit = max(0, next_boost - clock)
            duration = min(remaining[index], quantum_limit, boost_limit)
            preempt_at_arrival = False
            if level > 0 and pending:
                until_arrival = pending[0][1]["arrival"] - clock
                if 0 < until_arrival < duration:
                    duration = until_arrival
                    preempt_at_arrival = True
            record(index, duration)
            admit_mlfq()

            if clock >= next_boost:
                queues[0] = queues[0] + queues[1] + queues[2]
                queues[1], queues[2] = [], []
                if remaining[index] > 0:
                    queues[0].append(index)
                next_boost += boost_interval
            elif remaining[index] > 0:
                if preempt_at_arrival:
                    queues[level].append(index)
                elif duration >= quantum_limit - 0.000001:
                    queues[min(level + 1, 2)].append(index)
                else:
                    queues[level].append(index)
    elif algorithm == "Round Robin":
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
            elif algorithm == "LJF":
                index = min(ready, key=lambda i: (-remaining[i], jobs[i]["arrival"], i))
            elif algorithm == "HRRN":
                def response_ratio(i):
                    executed = jobs[i]["burst"] - remaining[i]
                    waiting = clock - jobs[i]["arrival"] - executed
                    return -((waiting + remaining[i]) / remaining[i])
                index = min(ready, key=lambda i: (response_ratio(i), jobs[i]["arrival"], i))
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


def simulate_memory(pages, frame_count, algorithm):
    frames = []
    states = []
    hits = 0
    last_used = {}
    fifo_position = 0
    for position, page in enumerate(pages):
        fault = page not in frames
        if not fault:
            hits += 1
        elif len(frames) < frame_count:
            frames.append(page)
        elif algorithm == "FIFO":
            frames[fifo_position] = page
            fifo_position = (fifo_position + 1) % frame_count
        elif algorithm == "LRU":
            victim = min(frames, key=lambda item: last_used.get(item, -1))
            frames[frames.index(victim)] = page
        else:
            next_use = {}
            for resident in frames:
                try:
                    next_use[resident] = pages.index(resident, position + 1)
                except ValueError:
                    next_use[resident] = float("inf")
            victim = max(frames, key=lambda item: next_use[item])
            frames[frames.index(victim)] = page
        last_used[page] = position
        states.append({"page": page, "frames": frames.copy(), "fault": fault})
    faults = len(pages) - hits
    return {
        "algorithm": algorithm,
        "states": states,
        "hits": hits,
        "faults": faults,
        "fault_rate": round(faults / len(pages) * 100, 2),
        "frame_count": frame_count
    }


def simulate_disk(requests, head, max_cylinder, algorithm, direction):
    left = sorted((request for request in requests if request < head), reverse=True)
    right = sorted(request for request in requests if request >= head)
    if algorithm == "FCFS":
        order = requests.copy()
    elif algorithm == "SSTF":
        remaining = requests.copy()
        position = head
        order = []
        while remaining:
            selected = min(range(len(remaining)), key=lambda i: (abs(remaining[i] - position), i))
            position = remaining.pop(selected)
            order.append(position)
    elif algorithm in {"SCAN", "C-SCAN", "LOOK", "C-LOOK"}:
        outward = left if direction == "left" else right
        inward = right if direction == "left" else left
        order = outward.copy()
        if algorithm == "SCAN":
            order.append(0 if direction == "left" else max_cylinder)
        elif algorithm == "C-SCAN":
            order.extend([0 if direction == "left" else max_cylinder,
                          max_cylinder if direction == "left" else 0])
            order.extend(reversed(inward))
        elif algorithm == "C-LOOK" and inward:
            order.append(inward[-1])
            order.extend(inward[-2::-1])
        else:
            order.extend(inward)
    else:
        raise ValueError("Choose a supported disk scheduling algorithm.")

    path = [head]
    for cylinder in order:
        if not path or cylinder != path[-1]:
            path.append(cylinder)
    movements = [abs(path[i] - path[i - 1]) for i in range(1, len(path))]
    total_seek = sum(movements)
    return {
        "algorithm": algorithm,
        "head": head,
        "path": path,
        "order": order,
        "movements": movements,
        "total_seek": total_seek,
        "average_seek": round(total_seek / len(requests), 2) if requests else 0,
        "request_count": len(requests)
    }


def bankers_safety(allocation, maximum, available):
    process_count = len(allocation)
    resource_count = len(available)
    if not process_count or len(maximum) != process_count:
        raise ValueError("Allocation and maximum matrices must have the same non-zero number of processes.")
    for matrix in (allocation, maximum):
        if any(len(row) != resource_count for row in matrix):
            raise ValueError("Every matrix row must match the available resource count.")
    if any(maximum[p][r] < allocation[p][r] for p in range(process_count) for r in range(resource_count)):
        raise ValueError("A process allocation cannot exceed its declared maximum.")

    need = [[maximum[p][r] - allocation[p][r] for r in range(resource_count)] for p in range(process_count)]
    work = available.copy()
    finished = [False] * process_count
    sequence = []
    while len(sequence) < process_count:
        selected = next((p for p in range(process_count) if not finished[p] and
                         all(need[p][r] <= work[r] for r in range(resource_count))), None)
        if selected is None:
            break
        for resource in range(resource_count):
            work[resource] += allocation[selected][resource]
        finished[selected] = True
        sequence.append(f"P{selected}")
    return {"safe": len(sequence) == process_count, "sequence": sequence, "need": need,
            "remaining": [f"P{p}" for p, done in enumerate(finished) if not done]}


def simulate_bounded_buffer(capacity, operations):
    buffer = []
    producer_queue, consumer_queue = [], []
    trace = []
    task_counts = {"P": 0, "C": 0}
    item_count = 0
    empty_count, full_count, mutex = capacity, 0, 1

    def record(task, event):
        trace.append({"step": len(trace) + 1, "task": task, "event": event,
                      "buffer": buffer.copy(), "empty": empty_count,
                      "full": full_count, "mutex": mutex})

    def perform(task, operation):
        nonlocal item_count, empty_count, full_count, mutex
        if operation == "P":
            if empty_count == 0:
                producer_queue.append(task)
                record(task, "wait(empty): buffer is full")
                return
            empty_count -= 1
            record(task, "wait(empty): acquired")
            mutex = 0
            record(task, "wait(mutex): acquired")
            item_count += 1
            buffer.append(f"Item {item_count}")
            record(task, f"produce Item {item_count}")
            mutex = 1
            record(task, "signal(mutex)")
            full_count += 1
            record(task, "signal(full)")
            if consumer_queue and full_count:
                waiting = consumer_queue.pop(0)
                record(waiting, "woken by signal(full)")
                perform(waiting, "C")
        else:
            if full_count == 0:
                consumer_queue.append(task)
                record(task, "wait(full): buffer is empty")
                return
            full_count -= 1
            record(task, "wait(full): acquired")
            mutex = 0
            record(task, "wait(mutex): acquired")
            item = buffer.pop(0)
            record(task, f"consume {item}")
            mutex = 1
            record(task, "signal(mutex)")
            empty_count += 1
            record(task, "signal(empty)")
            if producer_queue and empty_count:
                waiting = producer_queue.pop(0)
                record(waiting, "woken by signal(empty)")
                perform(waiting, "P")

    for operation in operations:
        task_counts[operation] += 1
        role = "Producer" if operation == "P" else "Consumer"
        perform(f"{role} {task_counts[operation]}", operation)
    return {
        "capacity": capacity,
        "trace": trace,
        "buffer": buffer,
        "empty": empty_count,
        "full": full_count,
        "blocked": producer_queue + consumer_queue,
        "completed_operations": len(operations) - len(producer_queue) - len(consumer_queue)
    }


def simulate_file_allocation(files, block_count, algorithm, reserved=None):
    reserved = set(reserved or [])
    free = [block for block in range(block_count) if block not in reserved]
    used = reserved.copy()
    results = []
    for file in files:
        size = file["blocks"]
        data_blocks = []
        index_block = None
        if algorithm == "Contiguous":
            run_start = None
            run_length = 0
            for block in free:
                if run_start is not None and block == previous + 1:
                    run_length += 1
                else:
                    run_start, run_length = block, 1
                previous = block
                if run_length == size:
                    data_blocks = list(range(run_start, run_start + size))
                    break
        elif algorithm == "Linked":
            allocation_order = free[::2] + free[1::2]
            data_blocks = allocation_order[:size]
        else:
            if len(free) >= size + 1:
                index_block = free[0]
                data_blocks = free[1:size + 1]

        allocated = len(data_blocks) == size
        fragmented = algorithm == "Contiguous" and not allocated and len(free) >= size
        if allocated:
            allocated_blocks = ([index_block] if index_block is not None else []) + data_blocks
            used.update(allocated_blocks)
            free = [block for block in free if block not in set(allocated_blocks)]
        results.append({"name": file["name"], "requested": size, "allocated": allocated,
                        "fragmented": fragmented, "blocks": data_blocks if allocated else [],
                        "index_block": index_block if allocated else None})
    return {
        "algorithm": algorithm, "block_count": block_count, "used_count": len(used),
        "reserved": sorted(reserved),
        "free_count": block_count - len(used), "files": results,
        "external_fragmentation": any(item["fragmented"] for item in results)
    }


def simulate_partition_allocation(partitions, processes, algorithm):
    available = [True] * len(partitions)
    placements = []
    next_position = 0
    internal_fragmentation = 0
    external_fragmentation = False
    for process in processes:
        candidates = [index for index, size in enumerate(partitions)
                      if available[index] and size >= process["size"]]
        selected = None
        if candidates:
            if algorithm == "First Fit":
                selected = candidates[0]
            elif algorithm == "Best Fit":
                selected = min(candidates, key=lambda index: (partitions[index] - process["size"], index))
            elif algorithm == "Worst Fit":
                selected = max(candidates, key=lambda index: (partitions[index] - process["size"], -index))
            else:
                selected = next((index for offset in range(len(partitions))
                                 if (index := (next_position + offset) % len(partitions)) in candidates), None)
        if selected is None:
            external_fragmentation |= sum(partitions[index] for index, is_free in enumerate(available) if is_free) >= process["size"]
            placements.append({**process, "partition": None, "allocated": False, "internal_fragmentation": 0})
            continue
        available[selected] = False
        waste = partitions[selected] - process["size"]
        internal_fragmentation += waste
        placements.append({**process, "partition": selected, "allocated": True, "internal_fragmentation": waste})
        next_position = (selected + 1) % len(partitions)

    layout = []
    placement_by_partition = {item["partition"]: item for item in placements if item["allocated"]}
    for index, size in enumerate(partitions):
        allocation = placement_by_partition.get(index)
        layout.append({"partition": index + 1, "size": size,
                       "process": allocation["name"] if allocation else None,
                       "process_size": allocation["size"] if allocation else 0,
                       "internal_fragmentation": allocation["internal_fragmentation"] if allocation else 0})
    return {"algorithm": algorithm, "placements": placements, "layout": layout,
            "total_memory": sum(partitions), "free_memory": sum(size for index, size in enumerate(partitions) if available[index]),
            "allocated_processes": sum(item["allocated"] for item in placements),
            "internal_fragmentation": internal_fragmentation,
            "external_fragmentation": external_fragmentation}


@app.route("/")
def dashboard():
    return render_template("index.html", aging_interval=AGING_INTERVAL)


@app.route("/api/stats")
def stats():
    memory = psutil.virtual_memory()
    boot_time = psutil.boot_time()
    disk = psutil.disk_usage(os.path.abspath(os.sep))
    swap = psutil.swap_memory()
    net = psutil.net_io_counters()
    disk_io = psutil.disk_io_counters()
    running = 0
    thread_count = 0
    for process in psutil.process_iter(["status", "num_threads"]):
        try:
            running += process.info["status"] == psutil.STATUS_RUNNING
            thread_count += process.info["num_threads"] or 0
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    return jsonify({
        "cpu": psutil.cpu_percent(interval=0.2),
        "memory": memory.percent,
        "total_memory": round(memory.total / (1024 ** 3), 2),
        "used_memory": round(memory.used / (1024 ** 3), 2),
        "processes": len(psutil.pids()),
        "running": running,
        "uptime": int(time.time() - boot_time),
        "cores": CPU_COUNT,
        "threads": thread_count,
        "disk": disk.percent,
        "disk_used": round(disk.used / (1024 ** 3), 1),
        "disk_total": round(disk.total / (1024 ** 3), 1),
        "swap": swap.percent,
        "network_sent": net.bytes_sent,
        "network_recv": net.bytes_recv,
        "disk_read": disk_io.read_bytes if disk_io else 0,
        "disk_write": disk_io.write_bytes if disk_io else 0,
        "os_name": platform.system(),
        "os_release": platform.release(),
        "architecture": platform.machine()
    })


@app.route("/api/processes")
def processes():
    result = []

    for process in psutil.process_iter(["pid", "name", "memory_percent", "memory_info", "status", "num_threads", "username", "cpu_percent", "create_time"]):
        try:
            item = process.info
            result.append({
                "pid": item["pid"],
                "name": item["name"] or "Unknown",
                "memory": round(item["memory_percent"] or 0, 2),
                "rss_mb": round((item["memory_info"].rss if item["memory_info"] else 0) / (1024 ** 2), 1),
                # psutil reports process CPU as a percentage of one core; normalize
                # it to the same total-machine scale used by system CPU utilization.
                "cpu": round(min(100, (item["cpu_percent"] or 0) / CPU_COUNT), 2),
                "threads": item["num_threads"] or 0,
                "user": item["username"] or "Unknown",
                "created": item["create_time"],
                "status": item["status"] or "Unknown"
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    return jsonify(sorted(result, key=lambda p: p["cpu"], reverse=True))


@app.route("/api/simulate", methods=["POST"])
def simulate():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Expected a JSON object."}), 400

    algorithm = data.get("algorithm", "Round Robin")
    if not isinstance(algorithm, str) or algorithm not in {
        "FCFS", "SJF", "SRTF", "LJF", "HRRN", "Priority", "Priority Preemptive", "MLFQ",
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


@app.route("/api/memory/simulate", methods=["POST"])
def memory_simulate():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Expected a JSON object."}), 400
    pages = data.get("pages")
    algorithm = data.get("algorithm")
    frames = data.get("frames")
    if not isinstance(algorithm, str) or algorithm not in {"FIFO", "LRU", "Optimal"}:
        return jsonify({"error": "Choose FIFO, LRU, or Optimal page replacement."}), 400
    if not isinstance(pages, list) or not 1 <= len(pages) <= 100:
        return jsonify({"error": "Enter between 1 and 100 page references."}), 400
    if any(isinstance(page, bool) or not isinstance(page, (str, int)) or not str(page).strip() or len(str(page)) > 12 for page in pages):
        return jsonify({"error": "Page references must be short labels or whole numbers."}), 400
    if isinstance(frames, bool) or not isinstance(frames, int) or not 1 <= frames <= 16:
        return jsonify({"error": "Frame count must be between 1 and 16."}), 400
    return jsonify(simulate_memory([str(page).strip() for page in pages], frames, algorithm))


@app.route("/api/memory/partitions", methods=["POST"])
def memory_partition_simulate():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Expected a JSON object."}), 400
    partitions, processes, algorithm = data.get("partitions"), data.get("processes"), data.get("algorithm")
    if not isinstance(algorithm, str) or algorithm not in {"First Fit", "Best Fit", "Worst Fit", "Next Fit"}:
        return jsonify({"error": "Choose First Fit, Best Fit, Worst Fit, or Next Fit."}), 400
    if not isinstance(partitions, list) or not 1 <= len(partitions) <= 32 or any(
        isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= 1000000 for size in partitions
    ) or sum(partitions) > 1000000:
        return jsonify({"error": "Provide 1–32 positive partition sizes totaling at most 1,000,000 KB."}), 400
    if not isinstance(processes, list) or not 1 <= len(processes) <= 32:
        return jsonify({"error": "Provide 1–32 processes."}), 400
    names, clean_processes = set(), []
    for index, item in enumerate(processes, start=1):
        if not isinstance(item, dict):
            return jsonify({"error": f"Process {index} must be an object."}), 400
        name, size = item.get("name"), item.get("size")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 24:
            return jsonify({"error": f"Process {index} needs a name of 1–24 characters."}), 400
        if name.strip().casefold() in names:
            return jsonify({"error": "Process names must be unique."}), 400
        names.add(name.strip().casefold())
        if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= 1000000:
            return jsonify({"error": f"{name}: process size must be between 1 and 1,000,000 KB."}), 400
        clean_processes.append({"name": name.strip(), "size": size})
    return jsonify(simulate_partition_allocation(partitions, clean_processes, algorithm))


@app.route("/api/disk/simulate", methods=["POST"])
def disk_simulate():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Expected a JSON object."}), 400
    requests_value = data.get("requests")
    head = data.get("head")
    max_cylinder = data.get("max_cylinder", 199)
    algorithm = data.get("algorithm")
    direction = data.get("direction", "right")
    if not isinstance(algorithm, str) or algorithm not in {"FCFS", "SSTF", "SCAN", "C-SCAN", "LOOK", "C-LOOK"}:
        return jsonify({"error": "Choose a supported disk scheduling algorithm."}), 400
    if not isinstance(direction, str) or direction not in {"left", "right"}:
        return jsonify({"error": "Direction must be left or right."}), 400
    if isinstance(max_cylinder, bool) or not isinstance(max_cylinder, int) or not 1 <= max_cylinder <= 100000:
        return jsonify({"error": "Maximum cylinder must be between 1 and 100,000."}), 400
    if isinstance(head, bool) or not isinstance(head, int) or not 0 <= head <= max_cylinder:
        return jsonify({"error": "Initial head position must be within the cylinder range."}), 400
    if not isinstance(requests_value, list) or not 1 <= len(requests_value) <= 100:
        return jsonify({"error": "Enter between 1 and 100 cylinder requests."}), 400
    if any(isinstance(item, bool) or not isinstance(item, int) or not 0 <= item <= max_cylinder for item in requests_value):
        return jsonify({"error": "Every request must be a cylinder within the configured range."}), 400
    return jsonify(simulate_disk(requests_value, head, max_cylinder, algorithm, direction))


@app.route("/api/deadlock/banker", methods=["POST"])
def banker_simulate():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Expected a JSON object."}), 400
    allocation, maximum, available = data.get("allocation"), data.get("maximum"), data.get("available")
    if not isinstance(allocation, list) or not 1 <= len(allocation) <= 20 or not isinstance(maximum, list) or not isinstance(available, list) or not 1 <= len(available) <= 12:
        return jsonify({"error": "Provide allocation and maximum matrices for 1–20 processes and 1–12 resource types."}), 400
    matrices = [allocation, maximum, [available]]
    if any(not isinstance(matrix, list) or any(not isinstance(row, list) or len(row) != len(available) or
           any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in row) for row in matrix)
           for matrix in matrices):
        return jsonify({"error": "Resource matrices must contain non-negative whole numbers with matching columns."}), 400
    try:
        return jsonify(bankers_safety(allocation, maximum, available))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.route("/api/sync/bounded-buffer", methods=["POST"])
def bounded_buffer_simulate():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Expected a JSON object."}), 400
    capacity, operations = data.get("capacity"), data.get("operations")
    if isinstance(capacity, bool) or not isinstance(capacity, int) or not 1 <= capacity <= 20:
        return jsonify({"error": "Buffer capacity must be between 1 and 20."}), 400
    if not isinstance(operations, list) or not 1 <= len(operations) <= 40 or any(not isinstance(item, str) or item not in {"P", "C"} for item in operations):
        return jsonify({"error": "Provide 1–40 operations using P (produce) or C (consume)."}), 400
    return jsonify(simulate_bounded_buffer(capacity, operations))


@app.route("/api/files/allocation", methods=["POST"])
def file_allocation_simulate():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Expected a JSON object."}), 400
    files, block_count, algorithm = data.get("files"), data.get("block_count"), data.get("algorithm")
    reserved = data.get("reserved", [])
    if not isinstance(algorithm, str) or algorithm not in {"Contiguous", "Linked", "Indexed"}:
        return jsonify({"error": "Choose Contiguous, Linked, or Indexed allocation."}), 400
    if isinstance(block_count, bool) or not isinstance(block_count, int) or not 8 <= block_count <= 512:
        return jsonify({"error": "Disk block count must be between 8 and 512."}), 400
    if not isinstance(reserved, list) or len(reserved) > block_count or any(
        isinstance(block, bool) or not isinstance(block, int) or not 0 <= block < block_count for block in reserved
    ) or len(set(reserved)) != len(reserved):
        return jsonify({"error": "Reserved blocks must be unique block numbers within the disk range."}), 400
    if not isinstance(files, list) or not 1 <= len(files) <= 25:
        return jsonify({"error": "Enter between 1 and 25 files."}), 400
    names = set()
    clean_files = []
    for index, item in enumerate(files, start=1):
        if not isinstance(item, dict):
            return jsonify({"error": f"File {index} must be an object."}), 400
        name, size = item.get("name"), item.get("blocks")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 24:
            return jsonify({"error": f"File {index} needs a name of 1–24 characters."}), 400
        if name.strip().casefold() in names:
            return jsonify({"error": "File names must be unique."}), 400
        names.add(name.strip().casefold())
        if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= 512:
            return jsonify({"error": f"{name}: block count must be between 1 and 512."}), 400
        clean_files.append({"name": name.strip(), "blocks": size})
    return jsonify(simulate_file_allocation(clean_files, block_count, algorithm, reserved))


if __name__ == "__main__":
    app.run(host="127.0.0.1", debug=os.environ.get("FLASK_DEBUG") == "1")

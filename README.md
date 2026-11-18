# OS Resource Simulator

A local Flask dashboard for live host monitoring and interactive operating system algorithm simulations.

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 app.py
```

Open `http://127.0.0.1:5000`. For development reloading, start the app with `FLASK_DEBUG=1 python3 app.py`.

## Modules

- **Dashboard and process manager:** live CPU, memory, process count, per-process usage, thread count, and process inspection.
- **Resource monitor:** rolling CPU, memory, process, and disk I/O graphs with high-usage alerts.
- **CPU scheduling:** FCFS, SJF, SRTF, LJF, HRRN, priority, preemptive priority, aging, and Round Robin. Includes workload presets, Gantt timelines, and algorithm comparison.
- **Memory manager:** FIFO, LRU, and Optimal page replacement with frame-by-frame results.
- **Disk scheduling:** FCFS, SSTF, SCAN, C-SCAN, LOOK, and C-LOOK with seek-path visualization.
- **Deadlock safety:** Banker’s algorithm with editable allocation, maximum, and available-resource matrices.
- **System info:** host OS, release, architecture, logical CPUs, threads, disk, swap, and network counters.

Live system readings describe the machine running Flask. Scheduling, memory, disk, and deadlock modules operate on the values entered into their simulators; they do not change the host operating system.

## Stack

- Python, Flask, and psutil
- HTML, CSS, and vanilla JavaScript

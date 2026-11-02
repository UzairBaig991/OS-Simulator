const $ = (id) => document.getElementById(id);
const resourceHistory = [];
let currentProcesses = [];
let lastSimulationResults = null;
const SAMPLE_WORKLOAD = [
    { name: "Process A", arrival: 0, burst: 8, priority: 3 },
    { name: "Process B", arrival: 1, burst: 4, priority: 1 },
    { name: "Process C", arrival: 2, burst: 9, priority: 4 },
    { name: "Process D", arrival: 3, burst: 5, priority: 2 }
];
const MAX_PROCESSES = 12;

function formatUptime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return days ? `${days}d ${remainingHours}h` : `${hours}h ${minutes}m`;
}

async function fetchJSON(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
}

function setSystemStatus(online) {
    const status = $("systemStatus");
    status.classList.toggle("offline", !online);
    status.innerHTML = `<i></i> ${online ? "System online" : "Connection lost"}`;
}

async function loadStats() {
    try {
        const data = await fetchJSON("/api/stats");
        const cpu = Number(data.cpu);
        const memory = Number(data.memory);
        $("cpu").textContent = Number.isFinite(cpu) ? cpu.toFixed(1) : "--";
        $("memory").textContent = Number.isFinite(memory) ? memory.toFixed(1) : "--";
        $("cpuBar").style.width = `${Math.max(0, Math.min(100, cpu || 0))}%`;
        $("memoryBar").style.width = `${Math.max(0, Math.min(100, memory || 0))}%`;
        $("cpuDetail").textContent = "Live processor load";
        $("memoryDetail").textContent =
            `${data.used_memory} GB used of ${data.total_memory} GB`;
        $("processCount").textContent = Number(data.processes).toLocaleString();
        $("uptime").textContent = formatUptime(Number(data.uptime));
        $("lastUpdated").textContent = `Updated ${new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        })}`;
        resourceHistory.push({ cpu: cpu || 0, memory: memory || 0 });
        if (resourceHistory.length > 30) resourceHistory.shift();
        drawResourceChart();
        setSystemStatus(true);
    } catch (error) {
        console.error("Could not load system statistics:", error);
        $("cpuDetail").textContent = "Unable to reach the system monitor";
        setSystemStatus(false);
    }
}

function drawResourceChart() {
    const canvas = $("resourceChart");
    const context = canvas.getContext("2d");
    if (!context) return;

    const bounds = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(bounds.width * ratio);
    canvas.height = Math.round(bounds.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const width = bounds.width;
    const height = bounds.height;
    const left = 32;
    const right = width - 8;
    const top = 9;
    const bottom = height - 19;
    context.clearRect(0, 0, width, height);
    $("chartEmpty").classList.toggle("hidden", resourceHistory.length > 0);

    context.font = "9px DM Sans, Segoe UI, sans-serif";
    context.textAlign = "right";
    context.textBaseline = "middle";
    [0, 50, 100].forEach(value => {
        const y = bottom - (value / 100) * (bottom - top);
        context.beginPath();
        context.strokeStyle = "#1d2a3a";
        context.lineWidth = 1;
        context.moveTo(left, y);
        context.lineTo(right, y);
        context.stroke();
        context.fillStyle = "#6f7e93";
        context.fillText(`${value}%`, left - 7, y);
    });

    if (!resourceHistory.length) return;

    const series = [
        { key: "cpu", color: "#70e1c0" },
        { key: "memory", color: "#79a8ff" }
    ];
    series.forEach(({ key, color }) => {
        context.beginPath();
        resourceHistory.forEach((point, index) => {
            const x = resourceHistory.length === 1
                ? (left + right) / 2
                : left + (index / (resourceHistory.length - 1)) * (right - left);
            const y = bottom - (Math.max(0, Math.min(100, point[key])) / 100) * (bottom - top);
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
        });
        context.strokeStyle = color;
        context.lineWidth = 2;
        context.lineJoin = "round";
        context.lineCap = "round";
        context.stroke();
        if (resourceHistory.length === 1) {
            context.beginPath();
            context.arc((left + right) / 2, bottom - (resourceHistory[0][key] / 100) * (bottom - top), 3, 0, Math.PI * 2);
            context.fillStyle = color;
            context.fill();
        }
    });
}

function renderProcesses() {
    const query = $("processSearch").value.trim().toLocaleLowerCase();
    const sort = $("processSort").value;
    const processes = currentProcesses
        .filter(process => process.name.toLocaleLowerCase().includes(query))
        .sort((a, b) => {
            if (sort === "name") return a.name.localeCompare(b.name);
            if (sort === "pid") return a.pid - b.pid;
            return b.memory - a.memory;
        });
    const tbody = $("processTable");
    if (!processes.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="table-message">${
            currentProcesses.length ? "No processes match your search." : "No processes found."
        }</td></tr>`;
        $("processSummary").textContent = currentProcesses.length
            ? "Try a different process name"
            : "No process data available";
        return;
    }

    tbody.innerHTML = processes.map(process => {
        const name = escapeHTML(process.name);
        const status = String(process.status || "unknown").toLowerCase();
        const memory = Math.max(0, Math.min(100, Number(process.memory) || 0));
        return `<tr>
            <td><span class="process-name-cell"><span class="process-avatar">${escapeHTML(process.name.charAt(0) || "?")}</span>${name}</span></td>
            <td>${Number(process.pid)}</td>
            <td class="memory-cell"><span class="memory-reading"><span>${memory.toFixed(2)}%</span><span class="memory-track"><i style="width:${memory}%"></i></span></span></td>
            <td><span class="status-tag ${escapeHTML(status)}">${escapeHTML(status)}</span></td>
        </tr>`;
    }).join("");
    $("processSummary").textContent = `Showing ${processes.length} of ${currentProcesses.length} processes`;
}

async function loadProcesses() {
    const tbody = $("processTable");
    try {
        currentProcesses = await fetchJSON("/api/processes");
        renderProcesses();
    } catch (error) {
        console.error("Could not load processes:", error);
        tbody.innerHTML = "<tr><td colspan='4' class='table-message'>Unable to load processes. Check the system monitor.</td></tr>";
        $("processSummary").textContent = "Process data unavailable";
    }
}

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;",
        '"': "&quot;", "'": "&#39;"
    })[ch]);
}

function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(2) : "—";
}

function processColor(name) {
    const colors = ["#80dfc0", "#91b5ff", "#d0a6ff", "#ffc27c"];
    const index = [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0);
    return colors[index % colors.length];
}

function renderTimeline(timeline) {
    const end = timeline.reduce((max, entry) => Math.max(max, entry.start + entry.duration), 0);
    if (!timeline.length || end <= 0) return "<p class='section-description'>No execution timeline was returned.</p>";

    let cursor = 0;
    const segments = timeline.map(entry => {
        const idle = Math.max(0, entry.start - cursor);
        cursor = entry.start + entry.duration;
        const idleMarkup = idle > 0
            ? `<span class="timeline-segment" style="--segment:${idle};background:#283447;color:#aab5c5" title="Idle: ${formatNumber(idle)} time units">Idle</span>`
            : "";
        const name = escapeHTML(entry.name);
        const duration = Number(entry.duration) || 0;
        return `${idleMarkup}<span class="timeline-segment" style="--segment:${duration};background:${processColor(entry.name)}" title="${name}: ${formatNumber(duration)} time units">${name.replace("Process ", "P")}</span>`;
    }).join("");
    return `<div class="timeline-heading"><span>CPU execution order</span><span>${formatNumber(end)} time units</span></div>
        <div class="timeline">${segments}</div>
        <div class="timeline-scale"><span>0</span><span>${formatNumber(end / 2)}</span><span>${formatNumber(end)}</span></div>`;
}

function renderWorkload(jobs) {
    $("workloadTable").innerHTML = jobs.map(job => `<tr>
        <td><input class="workload-input workload-name" data-field="name" maxlength="24" value="${escapeHTML(job.name)}" aria-label="Process name"></td>
        <td><input class="workload-input" data-field="arrival" type="number" min="0" max="10000" step="1" value="${job.arrival}" aria-label="Arrival time"></td>
        <td><input class="workload-input" data-field="burst" type="number" min="1" max="500" step="1" value="${job.burst}" aria-label="CPU burst"></td>
        <td><input class="workload-input" data-field="priority" type="number" min="1" max="10" step="1" value="${job.priority}" aria-label="Priority"></td>
        <td><button class="remove-process" type="button" aria-label="Remove ${escapeHTML(job.name)}" title="Remove process">×</button></td>
    </tr>`).join("");
    $("workloadBadge").textContent = `${jobs.length} PROCES${jobs.length === 1 ? "S" : "SES"}`;
    $("addProcess").disabled = jobs.length >= MAX_PROCESSES;
    $("workloadStatus").textContent = "Unsaved workload changes";
}

function readWorkload() {
    const jobs = [...$("workloadTable").querySelectorAll("tr")].map(row => {
        const getValue = field => row.querySelector(`[data-field="${field}"]`).value.trim();
        return {
            name: getValue("name"),
            arrival: Number(getValue("arrival")),
            burst: Number(getValue("burst")),
            priority: Number(getValue("priority"))
        };
    });
    if (!jobs.length || jobs.length > MAX_PROCESSES) {
        throw new Error(`Add between 1 and ${MAX_PROCESSES} processes to your workload.`);
    }
    const names = new Set();
    let totalBurst = 0;
    for (const job of jobs) {
        if (!job.name || job.name.length > 24) {
            throw new Error("Each process needs a name of 1–24 characters.");
        }
        if (names.has(job.name.toLocaleLowerCase())) {
            throw new Error("Process names must be unique.");
        }
        names.add(job.name.toLocaleLowerCase());
        if (!Number.isInteger(job.arrival) || job.arrival < 0 || job.arrival > 10000) {
            throw new Error(`${job.name}: arrival must be a whole number from 0 to 10,000.`);
        }
        if (!Number.isInteger(job.burst) || job.burst < 1 || job.burst > 500) {
            throw new Error(`${job.name}: CPU burst must be a whole number from 1 to 500.`);
        }
        if (!Number.isInteger(job.priority) || job.priority < 1 || job.priority > 10) {
            throw new Error(`${job.name}: priority must be a whole number from 1 to 10.`);
        }
        totalBurst += job.burst;
    }
    if (totalBurst > 500) {
        throw new Error("Total CPU burst time cannot exceed 500 units.");
    }
    return jobs;
}

function saveWorkload() {
    try {
        const jobs = readWorkload();
        localStorage.setItem("orbit-saved-workload", JSON.stringify(jobs));
        $("workloadStatus").textContent = "Workload saved in this browser";
    } catch (error) {
        $("workloadStatus").textContent = error.message;
    }
}

function addProcess() {
    const rows = [...$("workloadTable").querySelectorAll("tr")];
    if (rows.length >= MAX_PROCESSES) return;
    const existing = new Set(rows.map(row =>
        row.querySelector('[data-field="name"]').value.trim().toLocaleLowerCase()
    ));
    let suffix = rows.length + 1;
    let name = `Process ${String.fromCharCode(64 + Math.min(suffix, 26))}`;
    while (existing.has(name.toLocaleLowerCase())) {
        suffix += 1;
        name = `Process ${suffix}`;
    }
    const jobs = rows.map(row => ({
        name: row.querySelector('[data-field="name"]').value,
        arrival: Number(row.querySelector('[data-field="arrival"]').value),
        burst: Number(row.querySelector('[data-field="burst"]').value),
        priority: Number(row.querySelector('[data-field="priority"]').value)
    }));
    jobs.push({ name, arrival: 0, burst: 5, priority: 5 });
    renderWorkload(jobs);
    document.querySelector("#workloadTable tr:last-child [data-field='name']").focus();
}

function exportResultsCSV() {
    if (!lastSimulationResults) return;
    const columns = ["name", "arrival", "burst", "priority", "waiting", "turnaround", "response", "completion"];
    const csvCell = value => `"${String(value).replace(/"/g, '""')}"`;
    const content = [
        columns.join(","),
        ...lastSimulationResults.results.map(result =>
            columns.map(column => csvCell(result[column])).join(",")
        )
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `orbit-${lastSimulationResults.algorithm.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-results.csv`;
    link.click();
    URL.revokeObjectURL(url);
}

function renderSimulation(data) {
    const completion = data.timeline.reduce((max, entry) => Math.max(max, entry.start + entry.duration), 0);
    const rows = data.results.map(result => `<tr>
        <td>${escapeHTML(result.name)}</td><td>${formatNumber(result.arrival)}</td>
        <td>${formatNumber(result.burst)}</td><td>${formatNumber(result.priority)}</td>
        <td>${formatNumber(result.waiting)}</td><td>${formatNumber(result.turnaround)}</td>
        <td>${formatNumber(result.response)}</td>
    </tr>`).join("");
    lastSimulationResults = data;
    $("simulationResult").innerHTML = `
        <div class="result-header"><div><h3>${escapeHTML(data.algorithm)} results</h3><p>Performance for ${data.results.length} custom workload process${data.results.length === 1 ? "" : "es"}.</p></div><button id="exportResults" class="button button-secondary export-button" type="button">Export CSV ↓</button></div>
        <div class="result-stats">
            <div class="result-stat"><span>Average waiting</span><strong>${formatNumber(data.average_waiting)} units</strong></div>
            <div class="result-stat"><span>Average turnaround</span><strong>${formatNumber(data.average_turnaround)} units</strong></div>
            <div class="result-stat"><span>Average response</span><strong>${formatNumber(data.average_response)} units</strong></div>
            <div class="result-stat"><span>CPU utilization</span><strong>${formatNumber(data.cpu_utilization)}%</strong></div>
            <div class="result-stat"><span>Throughput</span><strong>${formatNumber(data.throughput)} / unit</strong></div>
        </div>
        ${renderTimeline(data.timeline)}
        <div class="table-wrap results-table"><table><thead><tr><th>PROCESS</th><th>ARRIVAL</th><th>BURST</th><th>PRIORITY</th><th>WAITING</th><th>TURNAROUND</th><th>RESPONSE</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    $("exportResults").addEventListener("click", exportResultsCSV);
}

async function requestSimulation(algorithm, jobs, quantum) {
    return fetchJSON("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ algorithm, quantum, jobs })
    });
}

async function runSimulation() {
    const algorithm = $("algorithm").value;
    const quantum = Number($("quantum").value);
    const buttons = [$("runSimulation"), $("compareSimulation")];
    if (!Number.isInteger(quantum) || quantum < 1 || quantum > 10000) {
        $("simulationResult").innerHTML = "<p class='table-message'>Enter a time quantum between 1 and 10,000 ms.</p>";
        $("quantum").focus();
        return;
    }
    let jobs;
    try {
        jobs = readWorkload();
    } catch (error) {
        $("simulationResult").innerHTML = `<p class="table-message">${escapeHTML(error.message)}</p>`;
        return;
    }
    buttons.forEach(button => { button.disabled = true; });
    $("simulationResult").innerHTML = "<p class='table-message'>Running the selected scheduling algorithm…</p>";
    try {
        const data = await requestSimulation(algorithm, jobs, quantum);
        renderSimulation(data);
    } catch (error) {
        console.error("Simulation failed:", error);
        $("simulationResult").innerHTML = `<p class="table-message">Simulation failed: ${escapeHTML(error.message)}</p>`;
    } finally {
        buttons.forEach(button => { button.disabled = false; });
    }
}

async function compareSimulations() {
    const algorithms = ["FCFS", "SJF", "SRTF", "Priority", "Priority Preemptive", "Aging", "Round Robin"];
    const quantum = Number($("quantum").value);
    if (!Number.isInteger(quantum) || quantum < 1 || quantum > 10000) {
        $("simulationResult").innerHTML = "<p class='table-message'>Enter a time quantum between 1 and 10,000 ms.</p>";
        $("quantum").focus();
        return;
    }
    let jobs;
    try {
        jobs = readWorkload();
    } catch (error) {
        $("simulationResult").innerHTML = `<p class="table-message">${escapeHTML(error.message)}</p>`;
        return;
    }
    const buttons = [$("runSimulation"), $("compareSimulation")];
    buttons.forEach(button => { button.disabled = true; });
    $("simulationResult").innerHTML = "<p class='table-message'>Comparing seven scheduling strategies…</p>";
    try {
        const comparisons = await Promise.all(algorithms.map(async algorithm => ({
            algorithm,
            data: await requestSimulation(algorithm, jobs, quantum)
        })));
        const best = Math.min(...comparisons.map(item => item.data.average_waiting));
        const rows = comparisons.map(item => {
            const isBest = item.data.average_waiting === best;
            const label = item.algorithm === "Aging" ? "Priority with aging" : item.algorithm;
            return `<tr class="${isBest ? "best-row" : ""}"><td>${escapeHTML(label)}${isBest ? " · Best wait" : ""}</td><td>${formatNumber(item.data.average_waiting)}</td><td>${formatNumber(item.data.average_turnaround)}</td><td>${formatNumber(item.data.average_response)}</td><td>${formatNumber(item.data.cpu_utilization)}%</td></tr>`;
        }).join("");
        lastSimulationResults = null;
        $("simulationResult").innerHTML = `<div class="result-header"><div><h3>Algorithm comparison</h3><p>Same ${jobs.length}-process workload. Lower wait is better.</p></div><span class="result-badge">7 algorithms</span></div>
            <div class="table-wrap"><table class="comparison-table"><thead><tr><th>ALGORITHM</th><th>AVG. WAITING</th><th>AVG. TURNAROUND</th><th>AVG. RESPONSE</th><th>CPU UTILIZATION</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    } catch (error) {
        console.error("Algorithm comparison failed:", error);
        $("simulationResult").innerHTML = `<p class="table-message">Comparison failed: ${escapeHTML(error.message)}</p>`;
    } finally {
        buttons.forEach(button => { button.disabled = false; });
    }
}

document.querySelectorAll(".nav-link").forEach(link => {
    link.addEventListener("click", () => {
        document.querySelectorAll(".nav-link").forEach(item => item.classList.remove("active"));
        link.classList.add("active");
    });
});
$("processSearch").addEventListener("input", renderProcesses);
$("processSort").addEventListener("change", renderProcesses);
$("refreshButton").addEventListener("click", () => {
    loadStats();
    loadProcesses();
});
$("runSimulation").addEventListener("click", runSimulation);
$("compareSimulation").addEventListener("click", compareSimulations);
$("addProcess").addEventListener("click", addProcess);
$("saveWorkload").addEventListener("click", saveWorkload);
$("restoreWorkload").addEventListener("click", () => {
    renderWorkload(SAMPLE_WORKLOAD.map(job => ({ ...job })));
});
$("workloadTable").addEventListener("input", () => {
    $("workloadStatus").textContent = "Unsaved workload changes";
});
$("workloadTable").addEventListener("click", event => {
    const button = event.target.closest(".remove-process");
    if (!button) return;
    const row = button.closest("tr");
    row.remove();
    $("workloadBadge").textContent = `${$("workloadTable").rows.length} PROCESSES`;
    $("addProcess").disabled = $("workloadTable").rows.length >= MAX_PROCESSES;
    $("workloadStatus").textContent = "Unsaved workload changes";
});
window.addEventListener("resize", drawResourceChart);

let initialWorkload = SAMPLE_WORKLOAD.map(job => ({ ...job }));
let restoredWorkload = false;
let workloadRestoreFailed = false;
try {
    const savedWorkload = localStorage.getItem("orbit-saved-workload");
    if (savedWorkload) {
        const parsedWorkload = JSON.parse(savedWorkload);
        if (Array.isArray(parsedWorkload) && parsedWorkload.length > 0 &&
            parsedWorkload.length <= MAX_PROCESSES &&
            parsedWorkload.every(job => job && typeof job.name === "string" &&
                Number.isInteger(job.arrival) && Number.isInteger(job.burst) &&
                Number.isInteger(job.priority))) {
            initialWorkload = parsedWorkload;
            restoredWorkload = true;
        } else {
            workloadRestoreFailed = true;
        }
    }
} catch (error) {
    console.error("Could not restore the saved workload:", error);
    workloadRestoreFailed = true;
}
renderWorkload(initialWorkload);
if (restoredWorkload) {
    $("workloadStatus").textContent = "Saved workload restored from this browser";
} else if (workloadRestoreFailed) {
    $("workloadStatus").textContent = "Saved workload was invalid; loaded the sample instead";
}
loadStats();
loadProcesses();
window.setInterval(loadStats, 2000);
window.setInterval(loadProcesses, 10000);

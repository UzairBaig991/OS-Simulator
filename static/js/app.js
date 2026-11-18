const $ = (id) => document.getElementById(id);
const resourceHistory = [];
let selectedChart = "cpu";
const activeResourceAlerts = new Set();
let currentProcesses = [];
let lastSimulationResults = null;
let monitorTimer = null;
let monitorPaused = false;
let lastConnectionState = null;
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

function formatBytes(bytes) {
    if (!Number.isFinite(Number(bytes))) return "--";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Number(bytes), unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function appendLog(message, kind = "info") {
    const log = $("systemLog");
    if (!log) return;
    const row = document.createElement("p");
    const marker = document.createElement("i");
    const text = document.createElement("span");
    const time = document.createElement("time");
    marker.className = `log-${kind}`;
    text.textContent = message;
    time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    row.append(marker, text, time);
    log.append(row);
    while (log.children.length > 30) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
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
    if (lastConnectionState !== online) {
        appendLog(online ? "Live system monitoring connected." : "System monitor connection lost.", online ? "success" : "error");
        lastConnectionState = online;
    }
}

function updateResourceHealth(data) {
    const conditions = [
        ["CPU", Number(data.cpu) >= 85, `${Number(data.cpu).toFixed(0)}%`],
        ["Memory", Number(data.memory) >= 90, `${Number(data.memory).toFixed(0)}%`],
        ["Disk", Number(data.disk) >= 90, `${Number(data.disk).toFixed(0)}%`]
    ];
    conditions.forEach(([name, warning, reading]) => {
        const wasActive = activeResourceAlerts.has(name);
        if (warning && !wasActive) appendLog(`High ${name.toLowerCase()} usage detected (${reading}).`, "warning");
        if (!warning && wasActive) appendLog(`${name} usage returned to normal.`, "success");
        if (warning) activeResourceAlerts.add(name);
        else activeResourceAlerts.delete(name);
    });
    const indicator = $("resourceHealth");
    const hasAlerts = activeResourceAlerts.size > 0;
    indicator.classList.toggle("warning", hasAlerts);
    indicator.innerHTML = `<i></i> ${hasAlerts ? `High ${[...activeResourceAlerts].join(" · ")} usage` : "Resources healthy"}`;
}

async function loadStats() {
    try {
        const data = await fetchJSON("/api/stats");
        updateResourceHealth(data);
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
        $("coreCount").textContent = Number(data.cores).toLocaleString();
        $("threadCount").textContent = Number(data.threads).toLocaleString();
        $("runningCount").textContent = Number(data.running).toLocaleString();
        $("diskUsage").textContent = `${Number(data.disk).toFixed(1)}%`;
        $("diskDetail").textContent = `${data.disk_used} GB of ${data.disk_total} GB`;
        $("swapUsage").textContent = `${Number(data.swap).toFixed(1)}%`;
        $("networkTotals").textContent = `${formatBytes(data.network_recv)} / ${formatBytes(data.network_sent)}`;
        $("osName").textContent = data.os_name || "Unknown";
        $("osRelease").textContent = data.os_release || "Unknown";
        $("architecture").textContent = data.architecture || "Unknown";
        $("lastUpdated").textContent = `Updated ${new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        })}`;
        const sampledAt = Date.now();
        const previous = resourceHistory[resourceHistory.length - 1];
        const elapsed = previous ? Math.max(0.001, (sampledAt - previous.time) / 1000) : 1;
        const diskReadRate = previous && Number.isFinite(Number(data.disk_read))
            ? Math.max(0, (Number(data.disk_read) - previous.diskRead) / elapsed) : 0;
        const diskWriteRate = previous && Number.isFinite(Number(data.disk_write))
            ? Math.max(0, (Number(data.disk_write) - previous.diskWrite) / elapsed) : 0;
        resourceHistory.push({
            time: sampledAt, cpu: cpu || 0, memory: memory || 0,
            uptime: Number(data.uptime) || 0,
            processes: Number(data.processes) || 0,
            diskRead: Number(data.disk_read) || 0, diskWrite: Number(data.disk_write) || 0,
            diskRate: diskReadRate + diskWriteRate
        });
        if (resourceHistory.length > 30) resourceHistory.shift();
        drawMetricSparklines();
        drawResourceChart();
        setSystemStatus(true);
    } catch (error) {
        console.error("Could not load system statistics:", error);
        $("cpuDetail").textContent = "Unable to reach the system monitor";
        setSystemStatus(false);
    }
}

function drawMetricSparklines() {
    const sparks = [["cpuSpark", "cpu"], ["memorySpark", "memory"], ["processSpark", "processes"], ["uptimeSpark", "uptime"]];
    sparks.forEach(([id, key]) => {
        const path = $(id);
        if (!path || !resourceHistory.length) return;
        const values = resourceHistory.map(point => key === "uptime" ? point.uptime / 60 : point[key]);
        const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
        const coords = values.map((value, index) => ({
            x: values.length === 1 ? 90 : index / (values.length - 1) * 180,
            y: 26 - (value - min) / range * 20
        }));
        path.setAttribute("d", coords.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "));
    });
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
    const left = 48;
    const right = width - 10;
    const top = 16;
    const bottom = height - 26;
    context.clearRect(0, 0, width, height);
    $("chartEmpty").classList.toggle("hidden", resourceHistory.length > 0);
    const chartConfig = {
        cpu: { key: "cpu", title: "CPU utilization", color: "#289bff", unit: "%", max: 100 },
        memory: { key: "memory", title: "Memory usage", color: "#16d996", unit: "%", max: 100 },
        processes: { key: "processes", title: "Active processes", color: "#ae70ff", unit: "", max: null },
        disk: { key: "diskRate", title: "Disk I/O throughput", color: "#ffb642", unit: " MB/s", max: null }
    }[selectedChart];
    $("chartTitle").textContent = chartConfig.title;
    $("resourceChart").setAttribute("aria-label", `Live ${chartConfig.title.toLowerCase()} over the last minute`);
    let values = resourceHistory.map(point => selectedChart === "disk" ? point.diskRate / (1024 * 1024) : point[chartConfig.key]);
    const maxValue = chartConfig.max || Math.max(selectedChart === "disk" ? 1 : 4, ...values) * 1.15;
    const axisMax = chartConfig.max || Math.max(1, Math.ceil(maxValue));
    $("chartCurrent").textContent = values.length
        ? `${chartConfig.title}: ${selectedChart === "disk" ? `${values[values.length - 1].toFixed(2)} MB/s` : `${values[values.length - 1].toFixed(selectedChart === "processes" ? 0 : 1)}${chartConfig.unit}`}`
        : "Waiting for readings";

    context.font = "10px DM Sans, Segoe UI, sans-serif";
    context.textAlign = "right";
    context.textBaseline = "middle";
    const divisions = 4;
    for (let index = 0; index <= divisions; index += 1) {
        const value = axisMax * (1 - index / divisions);
        const y = top + (index / divisions) * (bottom - top);
        context.beginPath();
        context.strokeStyle = "#303a65";
        context.lineWidth = 1;
        context.moveTo(left, y);
        context.lineTo(right, y);
        context.stroke();
        context.fillStyle = "#9aa6cf";
        const label = chartConfig.unit === "%" ? `${Math.round(value)}%`
            : selectedChart === "disk" ? `${value.toFixed(1)}` : `${Math.round(value)}`;
        context.fillText(label, left - 9, y);
    }

    if (!resourceHistory.length) return;
    const points = values.map((value, index) => ({
        x: values.length === 1 ? (left + right) / 2 : left + index / (values.length - 1) * (right - left),
        y: bottom - Math.max(0, Math.min(axisMax, value)) / axisMax * (bottom - top)
    }));
    const gradient = context.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, `${chartConfig.color}66`);
    gradient.addColorStop(1, `${chartConfig.color}03`);
    context.beginPath();
    context.moveTo(points[0].x, bottom);
    points.forEach(point => context.lineTo(point.x, point.y));
    context.lineTo(points[points.length - 1].x, bottom);
    context.closePath();
    context.fillStyle = gradient;
    context.fill();

    context.beginPath();
    points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
    });
    context.strokeStyle = chartConfig.color;
    context.lineWidth = 2.5;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.shadowColor = `${chartConfig.color}80`;
    context.shadowBlur = 8;
    context.stroke();
    context.shadowBlur = 0;
    const markerStep = Math.max(1, Math.floor(points.length / 12));
    points.forEach((point, index) => {
        if (index % markerStep !== 0 && index !== points.length - 1) return;
        context.beginPath();
        context.arc(point.x, point.y, index === points.length - 1 ? 3.5 : 2.5, 0, Math.PI * 2);
        context.fillStyle = chartConfig.color;
        context.fill();
        context.strokeStyle = "#f2f5ff";
        context.lineWidth = 1;
        context.stroke();
    });

    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillStyle = "#8592b7";
    const ticks = Math.min(6, resourceHistory.length);
    for (let index = 0; index < ticks; index += 1) {
        const pointIndex = ticks === 1 ? resourceHistory.length - 1 : Math.round(index / (ticks - 1) * (resourceHistory.length - 1));
        const point = resourceHistory[pointIndex];
        const x = points[pointIndex].x;
        context.beginPath(); context.moveTo(x, top); context.lineTo(x, bottom); context.strokeStyle = "#ffffff0b"; context.stroke();
        context.fillText(new Date(point.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }), x, bottom + 7);
    }
}

function renderProcesses() {
    const query = $("processSearch").value.trim().toLocaleLowerCase();
    const sort = $("processSort").value;
    const processes = currentProcesses
        .filter(process => process.name.toLocaleLowerCase().includes(query))
        .sort((a, b) => {
            if (sort === "name") return a.name.localeCompare(b.name);
            if (sort === "pid") return a.pid - b.pid;
            return b[sort] - a[sort];
        });
    const tbody = $("processTable");
    if (!processes.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="table-message">${
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
        const cpu = Math.max(0, Math.min(100, Number(process.cpu) || 0));
        return `<tr>
            <td><span class="process-name-cell"><span class="process-avatar">${escapeHTML(process.name.charAt(0) || "?")}</span>${name}</span></td>
            <td>${Number(process.pid)}</td>
            <td class="memory-cell"><span class="memory-reading"><span>${cpu.toFixed(1)}%</span><span class="memory-track cpu-track"><i style="width:${cpu}%"></i></span></span></td>
            <td class="memory-cell"><span class="memory-reading"><span>${memory.toFixed(2)}%</span><span class="memory-track"><i style="width:${memory}%"></i></span></span></td>
            <td>${Number(process.threads) || 0}</td>
            <td><span class="status-tag ${escapeHTML(status)}">${escapeHTML(status)}</span></td>
            <td><button class="inspect-process" type="button" data-pid="${Number(process.pid)}">Inspect</button></td>
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
        tbody.innerHTML = "<tr><td colspan='7' class='table-message'>Unable to load processes. Check the system monitor.</td></tr>";
        $("processSummary").textContent = "Process data unavailable";
    }
}

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;",
        '"': "&quot;", "'": "&#39;"
    })[ch]);
}

function inspectProcess(pid) {
    const process = currentProcesses.find(item => item.pid === pid);
    if (!process) return;
    $("inspectName").textContent = process.name || "Unknown process";
    $("inspectPid").textContent = process.pid;
    $("inspectCpu").textContent = `${Number(process.cpu || 0).toFixed(2)}%`;
    $("inspectMemory").textContent = `${Number(process.memory || 0).toFixed(2)}%`;
    $("inspectRss").textContent = `${Number(process.rss_mb || 0).toFixed(1)} MB`;
    $("inspectThreads").textContent = Number(process.threads || 0).toLocaleString();
    $("inspectStatus").textContent = process.status || "Unknown";
    $("inspectUser").textContent = process.user || "Unknown";
    $("inspectCreated").textContent = process.created
        ? new Date(Number(process.created) * 1000).toLocaleString() : "Unknown";
    $("processDialog").showModal();
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

function loadWorkloadPreset(preset) {
    const presets = {
        cpu: [
            { name: "Compile", arrival: 0, burst: 14, priority: 3 },
            { name: "Render", arrival: 1, burst: 11, priority: 4 },
            { name: "Index", arrival: 2, burst: 16, priority: 5 },
            { name: "Encode", arrival: 3, burst: 9, priority: 2 }
        ],
        io: [
            { name: "Browser", arrival: 0, burst: 3, priority: 3 },
            { name: "Editor", arrival: 2, burst: 2, priority: 2 },
            { name: "Sync", arrival: 4, burst: 4, priority: 4 },
            { name: "Terminal", arrival: 6, burst: 2, priority: 1 }
        ],
        priority: [
            { name: "Urgent", arrival: 0, burst: 7, priority: 1 },
            { name: "Backup", arrival: 1, burst: 12, priority: 8 },
            { name: "Service", arrival: 2, burst: 8, priority: 5 },
            { name: "Update", arrival: 3, burst: 10, priority: 9 }
        ]
    };
    if (presets[preset]) renderWorkload(presets[preset].map(job => ({ ...job })));
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

function exportProcessesCSV() {
    const columns = ["pid", "name", "cpu", "memory", "rss_mb", "threads", "status", "user", "created"];
    const cell = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = [columns.join(","), ...currentProcesses.map(process => columns.map(key => cell(process[key])).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "os-resource-processes.csv"; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function scheduleMonitor() {
    window.clearInterval(monitorTimer);
    if (!monitorPaused) monitorTimer = window.setInterval(() => { loadStats(); loadProcesses(); }, Number($("refreshRate").value));
}

const viewLabels = {
    dashboard: "Dashboard", processes: "Process Manager", resources: "Resource Monitor",
    cpu: "CPU Scheduling", memory: "Memory Manager", disk: "Disk Scheduling",
    deadlock: "Deadlock & Safety", starvation: "Starvation Prevention", system: "System Info"
};
const viewDescriptions = {
    processes: "Inspect live CPU, memory, thread count, and process state.",
    resources: "Follow CPU, memory, process, and disk activity over time.",
    cpu: "Model CPU scheduling policies and compare turnaround and response times.",
    starvation: "Explore aging and fairness for processes waiting on CPU time.",
    system: "Review live host resource and operating system telemetry."
};

function switchView(view, updateHistory = false) {
    if (!viewLabels[view]) return;
    const visiblePages = {
        dashboard: ["dashboard", "resources", "processes"],
        processes: ["processes"], resources: ["resources"],
        cpu: ["cpu"], memory: ["memory"], disk: ["disk"],
        deadlock: ["deadlock"], starvation: ["starvation"], system: ["system"]
    }[view];
    document.querySelectorAll("[data-view-page]").forEach(element => {
        element.hidden = !visiblePages.includes(element.dataset.viewPage);
    });
    const overview = document.querySelector('[data-view-container="overview"]');
    const operations = document.querySelector('[data-view-container="operations"]');
    overview.hidden = !["dashboard", "resources", "processes"].includes(view);
    operations.hidden = !["cpu", "starvation"].includes(view);
    const telemetry = document.querySelector(".advanced-telemetry");
    telemetry.open = view === "system";
    document.querySelectorAll(".nav-link[data-view]").forEach(link => {
        link.classList.toggle("active", link.dataset.view === view);
        if (link.dataset.view === view) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
    });
    $("breadcrumbCurrent").textContent = viewLabels[view].toLocaleUpperCase();
    const moduleHeading = $("moduleHeading");
    const hasGenericHeading = ["processes", "resources", "cpu", "starvation", "system"].includes(view);
    moduleHeading.hidden = !hasGenericHeading;
    if (hasGenericHeading) {
        $("moduleTitle").textContent = viewLabels[view];
        $("moduleDescription").textContent = viewDescriptions[view];
    }
    document.body.dataset.activeView = view;
    if (updateHistory && window.location.hash !== `#${view}`) window.history.pushState({ view }, "", `#${view}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (view === "dashboard" || view === "resources") drawResourceChart();
}

function parseIntegerList(value, label, maximum = 100) {
    const parts = value.split(",").map(part => part.trim());
    if (!parts.length || parts.length > maximum || parts.some(part => !/^\d+$/.test(part))) {
        throw new Error(`${label} must be a comma separated list of up to ${maximum} whole numbers.`);
    }
    return parts.map(Number);
}

function parseMatrix(text, label) {
    let matrix;
    try { matrix = JSON.parse(text); } catch { throw new Error(`${label} must be valid JSON.`); }
    if (!Array.isArray(matrix)) throw new Error(`${label} must be a JSON matrix.`);
    return matrix;
}

async function runMemoryPolicy(algorithm, pages, frames) {
    return fetchJSON("/api/memory/simulate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ algorithm, pages, frames })
    });
}

function renderMemoryResult(data) {
    const frameHeaders = Array.from({ length: data.frame_count }, (_, index) => `<th>FRAME ${index + 1}</th>`).join("");
    const rows = data.states.map((state, index) => `<tr class="${state.fault ? "fault-row" : "hit-row"}"><td>${index + 1}</td><td>${escapeHTML(state.page)}</td>${Array.from({ length: data.frame_count }, (_, frame) => `<td>${escapeHTML(state.frames[frame] ?? "–")}</td>`).join("")}<td><span class="result-badge ${state.fault ? "fault-badge" : "hit-badge"}">${state.fault ? "FAULT" : "HIT"}</span></td></tr>`).join("");
    $("memoryResult").innerHTML = `<div class="module-result-head"><strong>${escapeHTML(data.algorithm)} page replacement</strong><span>${data.faults} page faults · ${data.hits} hits · ${data.fault_rate}% fault rate</span></div><div class="table-wrap"><table class="module-data-table"><thead><tr><th>STEP</th><th>PAGE</th>${frameHeaders}<th>RESULT</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function submitMemory(compare = false) {
    let pages, frames;
    try {
        pages = parseIntegerList($("pageReferences").value, "Page reference string");
        frames = Number($("memoryFrames").value);
        if (!Number.isInteger(frames) || frames < 1 || frames > 16) throw new Error("Frame count must be between 1 and 16.");
    } catch (error) { $("memoryResult").innerHTML = `<p class="module-error">${escapeHTML(error.message)}</p>`; return; }
    const algorithms = compare ? ["FIFO", "LRU", "Optimal"] : [$("memoryAlgorithm").value];
    try {
        const results = await Promise.all(algorithms.map(algorithm => runMemoryPolicy(algorithm, pages, frames)));
        if (!compare) renderMemoryResult(results[0]);
        else {
            const best = Math.min(...results.map(item => item.faults));
            $("memoryResult").innerHTML = `<div class="module-result-head"><strong>Page replacement comparison</strong><span>${pages.length} references · ${frames} frames</span></div><div class="table-wrap"><table class="module-data-table"><thead><tr><th>POLICY</th><th>HITS</th><th>FAULTS</th><th>FAULT RATE</th></tr></thead><tbody>${results.map(item => `<tr class="${item.faults === best ? "best-row" : ""}"><td>${item.algorithm}${item.faults === best ? " · Best" : ""}</td><td>${item.hits}</td><td>${item.faults}</td><td>${item.fault_rate}%</td></tr>`).join("")}</tbody></table></div>`;
        }
        appendLog(`Memory simulation completed${compare ? " for all page policies" : ` with ${algorithms[0]}`}.`, "success");
    } catch (error) { $("memoryResult").innerHTML = `<p class="module-error">${escapeHTML(error.message)}</p>`; }
}

async function runDiskPolicy(algorithm, requests, head, maxCylinder, direction) {
    return fetchJSON("/api/disk/simulate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ algorithm, requests, head, max_cylinder: maxCylinder, direction })
    });
}

function renderDiskResult(data, maxCylinder) {
    const last = Math.max(1, data.path.length - 1);
    const points = data.path.map((cylinder, index) => `${10 + cylinder / maxCylinder * 980},${12 + index / last * 136}`).join(" ");
    const nodes = data.path.map((cylinder, index) => {
        const x = 10 + cylinder / maxCylinder * 980, y = 12 + index / last * 136;
        return `<circle cx="${x}" cy="${y}" r="5"><title>Step ${index}: cylinder ${cylinder}</title></circle>`;
    }).join("");
    $("diskResult").innerHTML = `<div class="module-result-head"><strong>${escapeHTML(data.algorithm)} seek path</strong><span>${data.total_seek} total seeks · ${data.average_seek} average</span></div><svg class="disk-plot" viewBox="0 0 1000 160" role="img" aria-label="Disk head movement path"><line x1="10" y1="150" x2="990" y2="150"></line><polyline points="${points}"></polyline>${nodes}</svg><div class="disk-scale"><span>0</span><span>${Math.round(maxCylinder / 2)}</span><span>${maxCylinder}</span></div><p class="sequence-line"><strong>Head order:</strong> ${data.path.map(value => `<span>${value}</span>`).join(" → ")}</p>`;
}

async function submitDisk(compare = false) {
    let requests, head, maxCylinder, direction;
    try {
        requests = parseIntegerList($("diskRequests").value, "Cylinder requests");
        head = Number($("diskHead").value); maxCylinder = Number($("maxCylinder").value); direction = $("diskDirection").value;
        if (!Number.isInteger(head) || !Number.isInteger(maxCylinder) || maxCylinder < 1 || maxCylinder > 100000 || head < 0 || head > maxCylinder) throw new Error("Set a valid head and maximum cylinder between 1 and 100,000.");
        if (requests.some(request => request > maxCylinder)) throw new Error("A request exceeds the configured maximum cylinder.");
    } catch (error) { $("diskResult").innerHTML = `<p class="module-error">${escapeHTML(error.message)}</p>`; return; }
    const algorithms = compare ? ["FCFS", "SSTF", "SCAN", "C-SCAN", "LOOK", "C-LOOK"] : [$("diskAlgorithm").value];
    try {
        const results = await Promise.all(algorithms.map(algorithm => runDiskPolicy(algorithm, requests, head, maxCylinder, direction)));
        if (!compare) renderDiskResult(results[0], maxCylinder);
        else {
            const best = Math.min(...results.map(item => item.total_seek));
            $("diskResult").innerHTML = `<div class="module-result-head"><strong>Disk scheduling comparison</strong><span>${requests.length} requests · head at ${head}</span></div><div class="table-wrap"><table class="module-data-table"><thead><tr><th>ALGORITHM</th><th>TOTAL SEEK</th><th>AVERAGE SEEK</th><th>ORDER</th></tr></thead><tbody>${results.map(item => `<tr class="${item.total_seek === best ? "best-row" : ""}"><td>${item.algorithm}${item.total_seek === best ? " · Best" : ""}</td><td>${item.total_seek}</td><td>${item.average_seek}</td><td>${item.order.join(" → ")}</td></tr>`).join("")}</tbody></table></div>`;
        }
        appendLog(`Disk simulation completed${compare ? " for all seek policies" : ` with ${algorithms[0]}`}.`, "success");
    } catch (error) { $("diskResult").innerHTML = `<p class="module-error">${escapeHTML(error.message)}</p>`; }
}

async function submitBanker() {
    let allocation, maximum, available;
    try {
        allocation = parseMatrix($("bankerAllocation").value, "Allocation matrix");
        maximum = parseMatrix($("bankerMaximum").value, "Maximum matrix");
        available = JSON.parse($("bankerAvailable").value);
        if (!Array.isArray(available)) throw new Error("Available resources must be a JSON array.");
    } catch (error) { $("bankerResult").innerHTML = `<p class="module-error">${escapeHTML(error.message || "Available resources must be valid JSON.")}</p>`; return; }
    try {
        const data = await fetchJSON("/api/deadlock/banker", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allocation, maximum, available }) });
        const sequence = data.safe ? data.sequence.join(" → ") : `No safe sequence. Waiting processes: ${data.remaining.join(", ")}`;
        $("bankerResult").innerHTML = `<div class="safety-result ${data.safe ? "safe" : "unsafe"}"><span class="safety-mark">${data.safe ? "✓" : "!"}</span><div><strong>${data.safe ? "Safe state" : "Unsafe state"}</strong><p>${escapeHTML(sequence)}</p></div></div><div class="table-wrap"><table class="module-data-table"><thead><tr><th>PROCESS</th>${available.map((_, index) => `<th>NEED R${index + 1}</th>`).join("")}</tr></thead><tbody>${data.need.map((row, index) => `<tr><td>P${index}</td>${row.map(value => `<td>${value}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
        appendLog(`Banker's algorithm reports an ${data.safe ? "available safe state" : "unsafe resource state"}.`, data.safe ? "success" : "warning");
    } catch (error) { $("bankerResult").innerHTML = `<p class="module-error">${escapeHTML(error.message)}</p>`; }
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
    appendLog(`Started ${algorithm} scheduling simulation.`, "info");
    $("simulationResult").innerHTML = "<p class='table-message'>Running the selected scheduling algorithm…</p>";
    try {
        const data = await requestSimulation(algorithm, jobs, quantum);
        renderSimulation(data);
        appendLog(`${algorithm} simulation completed for ${jobs.length} processes.`, "success");
    } catch (error) {
        console.error("Simulation failed:", error);
        $("simulationResult").innerHTML = `<p class="table-message">Simulation failed: ${escapeHTML(error.message)}</p>`;
    } finally {
        buttons.forEach(button => { button.disabled = false; });
    }
}

async function compareSimulations() {
    const algorithms = ["FCFS", "SJF", "SRTF", "LJF", "HRRN", "Priority", "Priority Preemptive", "Aging", "Round Robin"];
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
    appendLog("Comparing all nine scheduling algorithms.", "info");
    $("simulationResult").innerHTML = "<p class='table-message'>Comparing nine scheduling strategies…</p>";
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
        appendLog("Scheduling comparison completed.", "success");
    $("simulationResult").innerHTML = `<div class="result-header"><div><h3>Algorithm comparison</h3><p>Same ${jobs.length}-process workload. Lower wait is better.</p></div><span class="result-badge">9 algorithms</span></div>
            <div class="table-wrap"><table class="comparison-table"><thead><tr><th>ALGORITHM</th><th>AVG. WAITING</th><th>AVG. TURNAROUND</th><th>AVG. RESPONSE</th><th>CPU UTILIZATION</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    } catch (error) {
        console.error("Algorithm comparison failed:", error);
        $("simulationResult").innerHTML = `<p class="table-message">Comparison failed: ${escapeHTML(error.message)}</p>`;
    } finally {
        buttons.forEach(button => { button.disabled = false; });
    }
}

document.querySelectorAll(".nav-link[data-view], .brand[data-view]").forEach(link => {
    link.addEventListener("click", event => { event.preventDefault(); switchView(link.dataset.view, true); });
});
window.addEventListener("popstate", () => switchView(viewLabels[window.location.hash.slice(1)] ? window.location.hash.slice(1) : "dashboard"));
$("runMemory").addEventListener("click", () => submitMemory(false));
$("compareMemory").addEventListener("click", () => submitMemory(true));
$("runDisk").addEventListener("click", () => submitDisk(false));
$("compareDisk").addEventListener("click", () => submitDisk(true));
$("runBanker").addEventListener("click", submitBanker);
document.querySelector(".aging-link").addEventListener("click", event => { event.preventDefault(); switchView("cpu", true); $("algorithm").value = "Aging"; });
document.querySelectorAll(".chart-tab").forEach(button => {
    button.addEventListener("click", () => {
        selectedChart = button.dataset.chart;
        document.querySelectorAll(".chart-tab").forEach(tab => {
            const active = tab === button;
            tab.classList.toggle("active", active);
            tab.setAttribute("aria-pressed", String(active));
        });
        drawResourceChart();
    });
});
$("processSearch").addEventListener("input", renderProcesses);
$("processSort").addEventListener("change", renderProcesses);
$("processTable").addEventListener("click", event => {
    const button = event.target.closest(".inspect-process");
    if (button) inspectProcess(Number(button.dataset.pid));
});
$("refreshButton").addEventListener("click", () => {
    loadStats();
    loadProcesses();
});
$("exportProcesses").addEventListener("click", exportProcessesCSV);
$("refreshRate").addEventListener("change", scheduleMonitor);
$("pauseMonitor").addEventListener("click", () => {
    monitorPaused = !monitorPaused;
    $("pauseMonitor").textContent = monitorPaused ? "Resume live updates" : "Pause live updates";
    appendLog(monitorPaused ? "Live monitor paused." : "Live monitor resumed.", monitorPaused ? "warning" : "success");
    scheduleMonitor();
});
$("clearLog").addEventListener("click", () => { $("systemLog").replaceChildren(); appendLog("Activity log cleared.", "info"); });
$("runSimulation").addEventListener("click", runSimulation);
$("compareSimulation").addEventListener("click", compareSimulations);
$("addProcess").addEventListener("click", addProcess);
$("workloadPreset").addEventListener("change", event => {
    loadWorkloadPreset(event.target.value);
    event.target.value = "";
});
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
scheduleMonitor();
const requestedView = window.location.hash.slice(1);
switchView(viewLabels[requestedView] ? requestedView : "dashboard");

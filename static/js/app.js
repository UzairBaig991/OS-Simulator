const $ = (id) => document.getElementById(id);
const resourceHistory = [];
let currentProcesses = [];

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

function renderSimulation(data) {
    const turnaround = data.results.reduce((sum, result) => sum + Number(result.turnaround), 0) / data.results.length;
    const completion = data.timeline.reduce((max, entry) => Math.max(max, entry.start + entry.duration), 0);
    const rows = data.results.map(result => `<tr>
        <td>${escapeHTML(result.name)}</td><td>${formatNumber(result.burst)}</td>
        <td>${formatNumber(result.waiting)}</td><td>${formatNumber(result.turnaround)}</td>
    </tr>`).join("");
    $("simulationResult").innerHTML = `
        <div class="result-header"><div><h3>${escapeHTML(data.algorithm)} results</h3><p>Performance breakdown for the sample workload.</p></div><span class="result-badge">Simulation complete</span></div>
        <div class="result-stats">
            <div class="result-stat"><span>Average waiting</span><strong>${formatNumber(data.average_waiting)} units</strong></div>
            <div class="result-stat"><span>Average turnaround</span><strong>${formatNumber(turnaround)} units</strong></div>
            <div class="result-stat"><span>Workload completed</span><strong>${formatNumber(completion)} units</strong></div>
        </div>
        ${renderTimeline(data.timeline)}
        <div class="table-wrap results-table"><table><thead><tr><th>PROCESS</th><th>BURST</th><th>WAITING</th><th>TURNAROUND</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function runSimulation() {
    const algorithm = $("algorithm").value;
    const quantum = Number($("quantum").value);
    const buttons = [$("runSimulation"), $("compareSimulation")];
    if (algorithm === "Round Robin" && (!Number.isInteger(quantum) || quantum < 1 || quantum > 10000)) {
        $("simulationResult").innerHTML = "<p class='table-message'>Enter a time quantum between 1 and 10,000 ms.</p>";
        $("quantum").focus();
        return;
    }
    buttons.forEach(button => { button.disabled = true; });
    $("simulationResult").innerHTML = "<p class='table-message'>Running the selected scheduling algorithm…</p>";
    try {
        const data = await fetchJSON("/api/simulate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ algorithm, quantum })
        });
        renderSimulation(data);
    } catch (error) {
        console.error("Simulation failed:", error);
        $("simulationResult").innerHTML = `<p class="table-message">Simulation failed: ${escapeHTML(error.message)}</p>`;
    } finally {
        buttons.forEach(button => { button.disabled = false; });
    }
}

async function compareSimulations() {
    const algorithms = ["FCFS", "SJF", "Priority", "Aging", "Round Robin"];
    const quantum = Number($("quantum").value);
    if (!Number.isInteger(quantum) || quantum < 1 || quantum > 10000) {
        $("simulationResult").innerHTML = "<p class='table-message'>Enter a time quantum between 1 and 10,000 ms.</p>";
        $("quantum").focus();
        return;
    }
    const buttons = [$("runSimulation"), $("compareSimulation")];
    buttons.forEach(button => { button.disabled = true; });
    $("simulationResult").innerHTML = "<p class='table-message'>Comparing five scheduling strategies…</p>";
    try {
        const comparisons = await Promise.all(algorithms.map(async algorithm => ({
            algorithm,
            data: await fetchJSON("/api/simulate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ algorithm, quantum })
            })
        })));
        const best = Math.min(...comparisons.map(item => item.data.average_waiting));
        const rows = comparisons.map(item => {
            const averageTurnaround = item.data.results.reduce((sum, result) => sum + result.turnaround, 0) / item.data.results.length;
            const isBest = item.data.average_waiting === best;
            const label = item.algorithm === "Aging" ? "Priority with aging" : item.algorithm;
            return `<tr class="${isBest ? "best-row" : ""}"><td>${escapeHTML(label)}${isBest ? " · Best" : ""}</td><td>${formatNumber(item.data.average_waiting)}</td><td>${formatNumber(averageTurnaround)}</td></tr>`;
        }).join("");
        $("simulationResult").innerHTML = `<div class="result-header"><div><h3>Algorithm comparison</h3><p>Same workload, five scheduling strategies. Lower wait is better.</p></div><span class="result-badge">5 algorithms</span></div>
            <div class="table-wrap"><table class="comparison-table"><thead><tr><th>ALGORITHM</th><th>AVG. WAITING</th><th>AVG. TURNAROUND</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
$("algorithm").addEventListener("change", () => {
    $("quantumControl").hidden = $("algorithm").value !== "Round Robin";
});
window.addEventListener("resize", drawResourceChart);

$("quantumControl").hidden = $("algorithm").value !== "Round Robin";
loadStats();
loadProcesses();
window.setInterval(loadStats, 2000);
window.setInterval(loadProcesses, 10000);

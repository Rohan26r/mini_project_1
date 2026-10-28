/* ═══════════════════════════════════════════════════════
   ChurnGuard Dashboard — JavaScript
   Handles file upload, API calls, chart rendering
   + Exit Interview (Profile Modal -> Chat Modal -> Feedback Modal)
   Uses app.py routes: /interview/start, /interview/chat, /interview/end
   ═══════════════════════════════════════════════════════ */

// ── Chart.js global defaults ──────────────────────────
Chart.defaults.color = '#8b97a8';
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.padding = 16;

const TOOLTIP_STYLE = {
    backgroundColor: '#1e293b',
    titleColor: '#f1f5f9',
    bodyColor: '#cbd5e1',
    borderColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    cornerRadius: 10,
    padding: 12,
    titleFont: { weight: '600' },
};

// ── State ─────────────────────────────────────────────
let allEmployees = [];
let dashboardData = null;

// Exit Interview state (kept, just wired to new UI)
let selectedEmployee = null;
let currentSession = null;
let isWaiting = false;

// ── DOM References ────────────────────────────────────
const uploadSection = document.getElementById('uploadSection');
const uploadBox = document.getElementById('uploadBox');
const uploadLoading = document.getElementById('uploadLoading');
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const dashboard = document.getElementById('dashboard');
const headerStats = document.getElementById('headerStats');
const newUploadBtn = document.getElementById('newUploadBtn');

// ── Upload handlers ───────────────────────────────────
uploadBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
});

uploadBox.addEventListener('click', () => fileInput.click());

uploadBox.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadBox.classList.add('drag-over');
});

uploadBox.addEventListener('dragleave', () => {
    uploadBox.classList.remove('drag-over');
});

uploadBox.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadBox.classList.remove('drag-over');
    if (e.dataTransfer.files.length) {
        handleFile(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
        handleFile(fileInput.files[0]);
    }
});

newUploadBtn.addEventListener('click', () => {
    dashboard.style.display = 'none';
    headerStats.style.display = 'none';
    uploadSection.style.display = 'flex';
    uploadBox.style.display = 'block';
    uploadLoading.style.display = 'none';
    fileInput.value = '';
});

// ── Send CSV to backend ───────────────────────────────
async function handleFile(file) {
    if (!file.name.endsWith('.csv')) {
        alert('Please upload a CSV file.');
        return;
    }

    uploadBox.style.display = 'none';
    uploadLoading.style.display = 'block';

    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch('/predict', { method: 'POST', body: formData });
        const data = await res.json();

        if (data.error) {
            alert('Error: ' + data.error);
            uploadBox.style.display = 'block';
            uploadLoading.style.display = 'none';
            return;
        }

        dashboardData = data;
        allEmployees = data.employees;
        renderDashboard(data);
    } catch (err) {
        alert('Failed to connect to the server. Make sure app.py is running.');
        uploadBox.style.display = 'block';
        uploadLoading.style.display = 'none';
    }
}

// ═══════════ RENDER DASHBOARD ═══════════
function renderDashboard(data) {
    const s = data.summary;

    // Hide upload, show dashboard
    uploadSection.style.display = 'none';
    dashboard.style.display = 'block';
    headerStats.style.display = 'flex';

    // Animate cards fresh
    document.querySelectorAll('.summary-card, .chart-card, .table-card').forEach(el => {
        el.style.animation = 'none';
        el.offsetHeight; // trigger reflow
        el.style.animation = '';
    });

    // ── Header stats ──
    document.getElementById('statTotal').textContent = s.total;
    document.getElementById('statHigh').textContent = s.highRisk;
    document.getElementById('statMed').textContent = s.mediumRisk;
    document.getElementById('statLow').textContent = s.lowRisk;

    // ── Summary cards ──
    document.getElementById('cardTotal').textContent = s.total;
    document.getElementById('cardHigh').textContent = s.highRisk;
    document.getElementById('cardHighPct').textContent = ((s.highRisk / s.total) * 100).toFixed(1) + '% of workforce';
    document.getElementById('cardMed').textContent = s.mediumRisk;
    document.getElementById('cardMedPct').textContent = ((s.mediumRisk / s.total) * 100).toFixed(1) + '% of workforce';
    document.getElementById('cardLow').textContent = s.lowRisk;
    document.getElementById('cardLowPct').textContent = ((s.lowRisk / s.total) * 100).toFixed(1) + '% of workforce';
    document.getElementById('cardAvg').textContent = (s.avgChurnProbability * 100).toFixed(1) + '%';

    // ── Charts ──
    renderRiskDonut(s);
    renderDeptRisk(data.departmentStats);
    renderOvertimeChart(data.overtimeStats);
    renderSatisfactionChart(data.satisfactionStats);
    renderWLBChart(data.workLifeStats);
    renderProbHistogram(data.employees);

    // ── Table ──
    populateDeptFilter(data.departmentStats);
    renderTable(data.employees);
    setupFilters();
}

// ═══════════ CHARTS ═══════════

// Destroy helper
const chartInstances = {};
function getCtx(id) {
    if (chartInstances[id]) chartInstances[id].destroy();
    return document.getElementById(id).getContext('2d');
}

// 1) Risk Donut
function renderRiskDonut(summary) {
    const ctx = getCtx('riskDonut');
    chartInstances['riskDonut'] = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['High Risk', 'Medium Risk', 'Low Risk'],
            datasets: [{
                data: [summary.highRisk, summary.mediumRisk, summary.lowRisk],
                backgroundColor: [
                    'rgba(239, 68, 68, 0.85)',
                    'rgba(245, 158, 11, 0.85)',
                    'rgba(16, 185, 129, 0.85)'
                ],
                borderColor: ['#ef4444', '#f59e0b', '#10b981'],
                borderWidth: 2,
                hoverOffset: 6,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '65%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { font: { size: 12, weight: '500' }, padding: 20 }
                },
                tooltip: { ...TOOLTIP_STYLE }
            }
        }
    });
}

// 2) Department Risk (Stacked Bar)
function renderDeptRisk(deptStats) {
    const labels = Object.keys(deptStats);
    const ctx = getCtx('deptRiskChart');
    chartInstances['deptRiskChart'] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'High',
                    data: labels.map(d => deptStats[d].high),
                    backgroundColor: 'rgba(239, 68, 68, 0.8)',
                    borderRadius: 4,
                },
                {
                    label: 'Medium',
                    data: labels.map(d => deptStats[d].medium),
                    backgroundColor: 'rgba(245, 158, 11, 0.8)',
                    borderRadius: 4,
                },
                {
                    label: 'Low',
                    data: labels.map(d => deptStats[d].low),
                    backgroundColor: 'rgba(16, 185, 129, 0.8)',
                    borderRadius: 4,
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top', labels: { font: { size: 11 } } },
                tooltip: { ...TOOLTIP_STYLE, mode: 'index', intersect: false }
            },
            scales: {
                x: {
                    stacked: true,
                    grid: { display: false },
                    ticks: { font: { size: 12, weight: '500' } }
                },
                y: {
                    stacked: true,
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { font: { size: 11 } }
                }
            }
        }
    });
}

// 3) Overtime Chart
function renderOvertimeChart(otStats) {
    const ctx = getCtx('overtimeChart');
    chartInstances['overtimeChart'] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Yes (OverTime)', 'No (OverTime)'],
            datasets: [{
                label: 'Avg Churn Probability',
                data: [otStats.yesAvg * 100, otStats.noAvg * 100],
                backgroundColor: [
                    'rgba(239, 68, 68, 0.8)',
                    'rgba(16, 185, 129, 0.8)'
                ],
                borderRadius: 10,
                borderSkipped: false,
                barThickness: 60,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...TOOLTIP_STYLE,
                    callbacks: {
                        label: (ctx) => {
                            const count = ctx.dataIndex === 0 ? otStats.yesCount : otStats.noCount;
                            return [`Avg Churn: ${ctx.raw.toFixed(1)}%`, `Employees: ${count}`];
                        }
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { callback: v => v + '%', font: { size: 11 } }
                },
                y: {
                    grid: { display: false },
                    ticks: { font: { size: 13, weight: '600' } }
                }
            }
        }
    });
}

// 4) Job Satisfaction
function renderSatisfactionChart(satStats) {
    const levels = Object.keys(satStats).sort();
    const labels = levels.map(l => {
        const names = { '1': 'Low', '2': 'Medium', '3': 'High', '4': 'Very High' };
        return names[l] || l;
    });

    const ctx = getCtx('satisfactionChart');
    chartInstances['satisfactionChart'] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Avg Churn Probability',
                data: levels.map(l => (satStats[l].avgProb * 100)),
                backgroundColor: levels.map(l => {
                    const v = satStats[l].avgProb;
                    if (v > 0.2) return 'rgba(239, 68, 68, 0.8)';
                    if (v > 0.15) return 'rgba(245, 158, 11, 0.8)';
                    return 'rgba(16, 185, 129, 0.8)';
                }),
                borderRadius: 8,
                borderSkipped: false,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...TOOLTIP_STYLE,
                    callbacks: {
                        afterBody: (ctx) => {
                            const l = levels[ctx[0].dataIndex];
                            return `Employees: ${satStats[l].total}  |  High Risk: ${satStats[l].highCount}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 12, weight: '500' } }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { callback: v => v + '%', font: { size: 11 } }
                }
            }
        }
    });
}

// 5) Work-Life Balance
function renderWLBChart(wlbStats) {
    const levels = Object.keys(wlbStats).sort();
    const labels = levels.map(l => {
        const names = { '1': 'Bad', '2': 'Good', '3': 'Better', '4': 'Best' };
        return names[l] || l;
    });

    const ctx = getCtx('wlbChart');
    chartInstances['wlbChart'] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Avg Churn Probability',
                data: levels.map(l => (wlbStats[l].avgProb * 100)),
                backgroundColor: levels.map(l => {
                    const v = wlbStats[l].avgProb;
                    if (v > 0.2) return 'rgba(239, 68, 68, 0.8)';
                    if (v > 0.15) return 'rgba(245, 158, 11, 0.8)';
                    return 'rgba(16, 185, 129, 0.8)';
                }),
                borderRadius: 8,
                borderSkipped: false,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...TOOLTIP_STYLE,
                    callbacks: {
                        afterBody: (ctx) => {
                            const l = levels[ctx[0].dataIndex];
                            return `Employees: ${wlbStats[l].total}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 12, weight: '500' } }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { callback: v => v + '%', font: { size: 11 } }
                }
            }
        }
    });
}

// 6) Probability Histogram
function renderProbHistogram(employees) {
    const bins = 20;
    const counts = new Array(bins).fill(0);
    employees.forEach(e => {
        const idx = Math.min(Math.floor(e.churnProbability * bins), bins - 1);
        counts[idx]++;
    });

    const labels = counts.map((_, i) => {
        const lo = (i / bins * 100).toFixed(0);
        const hi = ((i + 1) / bins * 100).toFixed(0);
        return `${lo}-${hi}%`;
    });

    const colors = counts.map((_, i) => {
        const mid = (i + 0.5) / bins;
        if (mid > 0.6) return 'rgba(239, 68, 68, 0.8)';
        if (mid > 0.3) return 'rgba(245, 158, 11, 0.8)';
        return 'rgba(16, 185, 129, 0.8)';
    });

    const ctx = getCtx('probHistogram');
    chartInstances['probHistogram'] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Employees',
                data: counts,
                backgroundColor: colors,
                borderRadius: 4,
                borderSkipped: false,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { ...TOOLTIP_STYLE }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        font: { size: 10 },
                        maxRotation: 45,
                        callback: function (val, index) {
                            return index % 2 === 0 ? this.getLabelForValue(val) : '';
                        }
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { font: { size: 11 } }
                }
            }
        }
    });
}

// ═══════════ EMPLOYEE TABLE ═══════════

function populateDeptFilter(deptStats) {
    const sel = document.getElementById('filterDept');
    sel.innerHTML = '<option value="all">All Departments</option>';
    Object.keys(deptStats).sort().forEach(d => {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        sel.appendChild(opt);
    });
}

function renderTable(employees) {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';

    employees.forEach(emp => {
        const tr = document.createElement('tr');
        if (emp.riskLevel === 'HIGH') tr.classList.add('risk-high');

        const probColor = emp.churnProbability > 0.6 ? '#ef4444'
            : emp.churnProbability > 0.3 ? '#f59e0b'
                : '#10b981';

        tr.innerHTML = `
            <td style="color:var(--text-primary);font-weight:600;">#${emp.id}</td>
            <td>${emp.age}</td>
            <td>${emp.department}</td>
            <td>${emp.jobRole}</td>
            <td>$${emp.monthlyIncome.toLocaleString()}</td>
            <td>${emp.overTime === 'Yes'
                ? '<span style="color:#f87171;font-weight:600;">Yes</span>'
                : '<span style="color:#94a3b8;">No</span>'}</td>
            <td>${'⭐'.repeat(emp.jobSatisfaction)}</td>
            <td>
                <div class="prob-bar-cell">
                    <span style="color:${probColor};font-weight:600;">${(emp.churnProbability * 100).toFixed(1)}%</span>
                    <div class="prob-bar">
                        <div class="prob-bar-fill" style="width:${emp.churnProbability * 100}%;background:${probColor};"></div>
                    </div>
                </div>
            </td>
            <td>
                <span class="risk-badge ${emp.riskLevel.toLowerCase()}">
                    ${emp.riskLevel === 'HIGH' ? '🔴' : emp.riskLevel === 'MEDIUM' ? '🟡' : '🟢'}
                    ${emp.riskLevel}
                </span>
            </td>
        `;

        // ✅ NEW UI FLOW: Row click opens PROFILE modal (UI only change)
        tr.addEventListener('click', () => openProfile(emp));
        tbody.appendChild(tr);
    });

    document.getElementById('tableCount').textContent =
        `Showing ${employees.length} employees — click any row to view profile`;
}

function setupFilters() {
    const deptFilter = document.getElementById('filterDept');
    const riskFilter = document.getElementById('filterRisk');
    const searchInput = document.getElementById('searchInput');

    function applyFilters() {
        const dept = deptFilter.value;
        const risk = riskFilter.value;
        const search = searchInput.value.toLowerCase().trim();

        const filtered = allEmployees.filter(emp => {
            if (dept !== 'all' && emp.department !== dept) return false;
            if (risk !== 'all' && emp.riskLevel !== risk) return false;
            if (search) {
                const haystack = `${emp.id} ${emp.jobRole} ${emp.department}`.toLowerCase();
                if (!haystack.includes(search)) return false;
            }
            return true;
        });

        renderTable(filtered);
    }

    deptFilter.addEventListener('change', applyFilters);
    riskFilter.addEventListener('change', applyFilters);
    searchInput.addEventListener('input', applyFilters);
}

/* ═══════════════════════════════════════════════════════
   Exit Interview UI (Profile Modal -> Chat -> Feedback)
   NOTE: Backend logic stays same:
   /interview/start, /interview/chat, /interview/end
   ═══════════════════════════════════════════════════════ */

const SAT_NAMES = { 1: 'Very Low', 2: 'Low', 3: 'High', 4: 'Very High' };
const WLB_NAMES = { 1: 'Bad', 2: 'Good', 3: 'Better', 4: 'Best' };
const EDU_NAMES = { 1: 'Below College', 2: 'College', 3: "Bachelor's", 4: "Master's", 5: 'Doctorate' };

// ── Profile Modal DOM ──
const profileModal = document.getElementById('profileModal');
const profileModalClose = document.getElementById('profileModalClose');
const startInterviewBtn = document.getElementById('startInterviewBtn');

// ── Chat Modal DOM ──
const chatModal = document.getElementById('chatModal');
const chatModalClose = document.getElementById('chatModalClose');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const endInterviewBtn = document.getElementById('endInterviewBtn');

// ── Feedback Modal DOM ──
const feedbackModal = document.getElementById('feedbackModal');
const feedbackContent = document.getElementById('feedbackContent');
const feedbackModalClose = document.getElementById('feedbackModalClose');
const newInterviewBtn = document.getElementById('newInterviewBtn');

function openProfile(emp) {
    selectedEmployee = emp;
    profileModal.style.display = 'flex';

    // If gender not available, default avatar
    const avatar = emp.gender === 'Female' ? '👩' : '👨';

    document.getElementById('pAvatar').textContent = avatar;
    document.getElementById('pName').textContent = `Employee #${emp.id}`;
    document.getElementById('pModalTitle').textContent = `👤 ${emp.jobRole} — #${emp.id}`;
    document.getElementById('pRole').textContent = emp.jobRole;
    document.getElementById('pDept').textContent = emp.department;

    const badge = document.getElementById('pRiskBadge');
    badge.textContent = `${emp.riskLevel === 'HIGH' ? '🔴' : emp.riskLevel === 'MEDIUM' ? '🟡' : '🟢'} ${emp.riskLevel} RISK`;
    badge.className = `p-risk-badge ${emp.riskLevel}`;

    document.getElementById('pChurn').textContent = `Churn: ${(emp.churnProbability * 100).toFixed(1)}%`;
    document.getElementById('pAge').textContent = emp.age ?? '—';
    document.getElementById('pGender').textContent = emp.gender || '—';
    document.getElementById('pMarital').textContent = emp.maritalStatus || '—';
    document.getElementById('pIncome').textContent = emp.monthlyIncome != null ? `$${emp.monthlyIncome.toLocaleString()}/mo` : '—';
    document.getElementById('pOT').textContent = emp.overTime || '—';
    document.getElementById('pJobSat').textContent = emp.jobSatisfaction != null ? `${emp.jobSatisfaction}/4 (${SAT_NAMES[emp.jobSatisfaction] || '?'})` : '—';
    document.getElementById('pEnvSat').textContent = emp.environmentSatisfaction != null ? `${emp.environmentSatisfaction}/4 (${SAT_NAMES[emp.environmentSatisfaction] || '?'})` : '—';
    document.getElementById('pWLB').textContent = emp.workLifeBalance != null ? `${emp.workLifeBalance}/4 (${WLB_NAMES[emp.workLifeBalance] || '?'})` : '—';
    document.getElementById('pYears').textContent = emp.yearsAtCompany != null ? `${emp.yearsAtCompany} years` : '—';
    document.getElementById('pPromo').textContent = emp.yearsSinceLastPromotion != null ? `${emp.yearsSinceLastPromotion}y ago` : '—';
    document.getElementById('pDistance').textContent = emp.distanceFromHome != null ? `${emp.distanceFromHome} km` : '—';
    document.getElementById('pEdu').textContent = emp.education != null ? (EDU_NAMES[emp.education] || emp.education) : '—';
    document.getElementById('pTravel').textContent = emp.businessTravel || '—';
    document.getElementById('pCompanies').textContent = emp.numCompaniesWorked ?? '—';
}

profileModalClose?.addEventListener('click', () => { profileModal.style.display = 'none'; });
profileModal?.addEventListener('click', (e) => { if (e.target === profileModal) profileModal.style.display = 'none'; });

// ── Start Interview Button ──
startInterviewBtn?.addEventListener('click', async () => {
    if (!selectedEmployee) return;

    try {
        const res = await fetch('/interview/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employeeId: selectedEmployee.id })
        });

        const data = await res.json();
        if (!res.ok || data.error) {
            alert(data.error || 'Failed to start interview.');
            return;
        }

        currentSession = data.sessionId;
        profileModal.style.display = 'none';
        openChatModal(selectedEmployee);
    } catch (err) {
        alert('Failed to start interview: ' + (err?.message || err));
    }
});

// ── Chat Modal ──
function openChatModal(emp) {
    chatModal.style.display = 'flex';

    const avatar = emp.gender === 'Female' ? '👩' : '👨';
    document.getElementById('chatAvatar').textContent = avatar;
    document.getElementById('chatTitle').textContent = `Exit Interview — ${emp.jobRole}`;
    document.getElementById('chatSubtitle').textContent =
        `Employee #${emp.id} · ${emp.department} · ${emp.riskLevel} Risk (${(emp.churnProbability * 100).toFixed(0)}%)`;

    const chatMessages = document.getElementById('chatMessages');
    chatMessages.innerHTML = `
        <div class="system-msg">
            <p>📋 <strong>You are the HR Manager.</strong> You're interviewing a <strong>${emp.riskLevel} risk</strong> ${emp.jobRole} from ${emp.department}.</p>
            <p>Churn probability: <strong>${(emp.churnProbability * 100).toFixed(0)}%</strong>. Try to understand their concerns and retain them.</p>
            <p class="hint">Tip: Greet warmly, ask open questions, listen actively, and offer concrete solutions — not vague promises.</p>
        </div>
    `;

    chatInput.value = '';
    chatInput.style.height = 'auto';
    chatInput.focus();
}

chatModalClose?.addEventListener('click', () => {
    if (currentSession && confirm('Leave the interview? You will lose conversation progress.')) {
        chatModal.style.display = 'none';
        currentSession = null;
        isWaiting = false;
        sendBtn.disabled = false;
    } else if (!currentSession) {
        chatModal.style.display = 'none';
    }
});

// ── Chat messaging ──
sendBtn?.addEventListener('click', sendMessage);

chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

chatInput?.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';
});

async function sendMessage() {
    const msg = (chatInput.value || '').trim();
    if (!msg || isWaiting || !currentSession) return;

    addChatMsg('hr', msg);
    chatInput.value = '';
    chatInput.style.height = 'auto';

    isWaiting = true;
    sendBtn.disabled = true;

    const typing = showTyping();

    try {
        const res = await fetch('/interview/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSession, message: msg })
        });

        const data = await res.json();
        removeTyping(typing);

        if (!res.ok || data.error) {
            addChatMsg('employee', '⚠️ ' + (data.error || 'Chat failed'));
        } else {
            addChatMsg('employee', data.reply || '(no reply)');
        }
    } catch (err) {
        removeTyping(typing);
        addChatMsg('employee', '⚠️ Connection error. Try again.');
    }

    isWaiting = false;
    sendBtn.disabled = false;
    chatInput.focus();
}

function addChatMsg(role, text) {
    const chatMessages = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    const label = role === 'hr' ? '🧑‍💼 HR Manager' : '👤 Employee';
    div.innerHTML = `<div class="msg-label">${label}</div>${escapeHtml(text)}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTyping() {
    const chatMessages = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = 'typing-indicator';
    div.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
}

function removeTyping(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
}

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

// ── End Interview & Feedback ──
endInterviewBtn?.addEventListener('click', async () => {
    if (!currentSession) return;
    if (!confirm('End interview and get your performance feedback?')) return;

    chatModal.style.display = 'none';
    feedbackModal.style.display = 'flex';
    feedbackContent.innerHTML =
        '<div class="spinner"></div><p style="text-align:center;margin-top:16px;color:var(--text-muted);">Analyzing your HR skills…</p>';

    try {
        const res = await fetch('/interview/end', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSession })
        });

        const data = await res.json();

        if (!res.ok || data.error) {
            feedbackContent.innerHTML = `<p style="color:#f87171;">⚠️ ${escapeHtml(data.error || 'Failed to generate feedback')}</p>`;
        } else {
            feedbackContent.innerHTML = formatFeedback(data.feedback || '(no feedback)');
            currentSession = null;
            isWaiting = false;
            sendBtn.disabled = false;
        }
    } catch (err) {
        feedbackContent.innerHTML = `<p style="color:#f87171;">⚠️ ${escapeHtml(err?.message || String(err))}</p>`;
    }
});

feedbackModalClose?.addEventListener('click', () => { feedbackModal.style.display = 'none'; });
newInterviewBtn?.addEventListener('click', () => { feedbackModal.style.display = 'none'; });

function formatFeedback(text) {
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/^### (.+)$/gm, '<h3 style="margin-top:16px;color:var(--text-primary);">$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h3 style="margin-top:16px;color:var(--text-primary);">$1</h3>');
    html = html.replace(/^[•\-\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/gs, '<ul style="padding-left:20px;margin:8px 0;">$1</ul>');
    html = html.replace(/(\d)\/5/g, (m, n) => '⭐'.repeat(parseInt(n)) + '☆'.repeat(5 - parseInt(n)) + ` (${m})`);
    html = html.replace(/\n/g, '<br>');
    return html;
}
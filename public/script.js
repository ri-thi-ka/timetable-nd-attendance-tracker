const $ = id => document.getElementById(id);

const S = {
  token: localStorage.getItem('ct_token') || '',
  user: JSON.parse(localStorage.getItem('ct_user') || 'null'),
  subjects: [],
  tt: [],
  chart: null,
  mode: 'login',
  liveId: null,
  liveTimer: null,
  barTimer: null,
  activeTimer: null,
  codeEnds: 0,
  stepMs: 20000
};

const isFaculty = () => S.user && S.user.role === 'faculty';

function esc(x) {
  return String(x ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function notice(msg, err = false) {
  $('notice').textContent = msg;
  $('notice').classList.remove('hidden', 'error');
  if (err) $('notice').classList.add('error');
  setTimeout(() => $('notice').classList.add('hidden'), 4500);
}

async function api(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  if (opts.body) headers['Content-Type'] = 'application/json';

  const r = await fetch(url, { ...opts, headers });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || 'Request failed');
  return d;
}

/* ------------------------------ sign in ------------------------------ */

function mode(m) {
  S.mode = m;
  $('nameWrap').classList.toggle('hidden', m !== 'register');
  $('roleWrap').classList.toggle('hidden', m !== 'register');
  $('name').required = m === 'register';
  $('loginTab').classList.toggle('active', m === 'login');
  $('regTab').classList.toggle('active', m === 'register');
  $('authMsg').textContent = '';
}

$('loginTab').onclick = () => mode('login');
$('regTab').onclick = () => mode('register');

$('authForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const d = await api('/api/auth/' + (S.mode === 'login' ? 'login' : 'register'), {
      method: 'POST',
      body: JSON.stringify({
        name: $('name').value,
        email: $('email').value,
        password: $('password').value,
        role: $('role').value
      })
    });
    S.token = d.token;
    S.user = d.user;
    localStorage.setItem('ct_token', S.token);
    localStorage.setItem('ct_user', JSON.stringify(S.user));
    await enter();
  } catch (x) {
    $('authMsg').textContent = x.message;
  }
};

function stopTimers() {
  clearInterval(S.liveTimer);
  clearInterval(S.barTimer);
  clearInterval(S.activeTimer);
  S.liveTimer = S.barTimer = S.activeTimer = null;
}

function showSignIn() {
  stopTimers();
  S.token = '';
  S.user = null;
  localStorage.removeItem('ct_token');
  localStorage.removeItem('ct_user');
  if (S.chart) S.chart.destroy();
  S.chart = null;
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
  mode('login');
}

$('logout').onclick = showSignIn;

async function enter() {
  if (!S.token) {
    $('auth').classList.remove('hidden');
    return;
  }

  try {
    const d = await api('/api/me');
    S.user = d.user;
  } catch {
    showSignIn();
    return;
  }

  const fac = isFaculty();
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('welcome').textContent = 'Welcome back, ' + S.user.name.split(' ')[0] + '!';
  $('who').textContent = S.user.name + ' · ' + S.user.email;
  $('rolePill').textContent = S.user.role.toUpperCase();

  $('addSubjectPanel').classList.toggle('hidden', !fac);
  $('joinClassPanel').classList.toggle('hidden', fac);
  $('liveFaculty').classList.toggle('hidden', !fac);
  $('liveStudent').classList.toggle('hidden', fac);
  $('navPlanner').style.display = fac ? 'none' : '';
  $('lblPresent').textContent = fac ? 'Present marks' : 'Classes attended';
  $('lblOverall').textContent = fac ? 'Class attendance' : 'Overall attendance';

  try {
    await load();
    if (fac) {
      await loadToday();
    } else {
      await refreshActive();
      clearInterval(S.activeTimer);
      S.activeTimer = setInterval(refreshActive, 10000);
    }
  } catch (e) {
    notice(e.message, true);
  }
}

/* ------------------------------- data -------------------------------- */

async function load() {
  [S.subjects, S.tt] = await Promise.all([
    api('/api/subjects'),
    api('/api/timetable')
  ]);
  render();
}

function fill(id) {
  const el = $(id);
  const v = el.value;
  el.innerHTML =
    '<option value="">Select subject</option>' +
    S.subjects.map(s =>
      `<option value="${s.id}">${esc(s.name)} (${esc(s.code)})</option>`
    ).join('');
  if (S.subjects.some(s => String(s.id) === v)) el.value = v;
}

function subjectCard(s) {
  const fac = isFaculty();
  const below = s.conducted && s.percentage < s.target;

  const info = fac
    ? `${s.enrolled} students · ${s.classes_held} classes held · target ${s.target}%`
    : `${s.attended}/${s.conducted} classes · target ${s.target}%` +
      (s.teacher_name ? ` · ${esc(s.teacher_name)}` : '');

  const extra = fac
    ? `<p class="mutedline">Join code: <b>${esc(s.join_code)}</b></p>
       <button class="primary" data-roster="${s.id}">View students</button>
       <button class="del" data-subdel="${s.id}">Delete subject</button>`
    : '';

  return `<div class="subcard">
    <h4>${esc(s.name)} <small>${esc(s.code)}</small></h4>
    <b>${s.conducted ? s.percentage + '%' : 'No records'}</b>
    <div class="bar"><span class="${below ? 'low' : ''}" style="width:${s.percentage}%"></span></div>
    <p class="mutedline">${info}</p>
    ${extra}
  </div>`;
}

function render() {
  ['ttSubject', 'calcSubject', 'startSubject'].forEach(fill);

  const p = S.subjects.reduce((n, s) => n + s.attended, 0);
  const c = S.subjects.reduce((n, s) => n + s.conducted, 0);
  const low = S.subjects.filter(s => s.conducted && s.percentage < s.target);

  $('nSubjects').textContent = S.subjects.length;
  $('nPresent').textContent = p;
  $('overall').textContent = c ? Math.round(p / c * 100) + '%' : '—';
  $('low').textContent = low.length;

  $('subList').innerHTML = S.subjects.length
    ? S.subjects.map(subjectCard).join('')
    : `<p class="muted">${isFaculty()
        ? 'Add your first subject above.'
        : 'Join a subject using the code from your faculty.'}</p>`;

  $('subList').querySelectorAll('[data-subdel]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Delete this subject, its students and all its records?')) return;
      try {
        await api('/api/subjects/' + b.dataset.subdel, { method: 'DELETE' });
        $('rosterPanel').classList.add('hidden');
        await load();
        notice('Subject deleted.');
      } catch (e) {
        notice(e.message, true);
      }
    };
  });

  $('subList').querySelectorAll('[data-roster]').forEach(b => {
    b.onclick = () => showRoster(Number(b.dataset.roster));
  });

  $('ttList').innerHTML = S.tt.length
    ? `<div class="tablewrap"><table><thead><tr><th>Day</th><th>Time</th><th>Subject</th><th>Room</th><th></th></tr></thead><tbody>${
        S.tt.map(t => `<tr><td>${esc(t.day)}</td><td>${esc(t.start_time)}–${esc(t.end_time)}</td><td>${esc(t.subject_name)}</td><td>${esc(t.room)}</td><td><button class="del" data-ttdel="${t.id}">Delete</button></td></tr>`).join('')
      }</tbody></table></div>`
    : '<p class="muted">No classes added yet.</p>';

  $('ttList').querySelectorAll('[data-ttdel]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Delete timetable entry?')) return;
      try {
        await api('/api/timetable/' + b.dataset.ttdel, { method: 'DELETE' });
        await load();
        notice('Entry deleted.');
      } catch (e) {
        notice(e.message, true);
      }
    };
  });

  $('next').innerHTML = S.tt.length
    ? S.tt.slice(0, 5).map(t =>
        `<div class="entry"><b>${esc(t.start_time)}–${esc(t.end_time)} · ${esc(t.subject_name)}</b><br>${esc(t.day)} · ${esc(t.room)}</div>`
      ).join('')
    : '<p class="muted">Add timetable entries to see them here.</p>';

  $('watch').innerHTML = low.length
    ? low.map(s =>
        `<div class="entry"><b>${esc(s.name)} — ${s.percentage}%</b><br>Target: ${s.target}%. ${isFaculty() ? 'The class average is below target.' : 'Plan to attend upcoming classes.'}</div>`
      ).join('')
    : '<p class="muted">No recorded subjects below target.</p>';

  $('noChart').classList.toggle('hidden', S.subjects.length > 0);
  if (S.chart) S.chart.destroy();
  S.chart = null;
  if (typeof Chart !== 'undefined' && S.subjects.length) {
    S.chart = new Chart($('chart'), {
      type: 'bar',
      data: {
        labels: S.subjects.map(s => s.code),
        datasets: [
          { label: 'Attendance %', data: S.subjects.map(s => s.percentage), backgroundColor: '#7166e8' },
          { label: 'Target %', data: S.subjects.map(s => s.target), backgroundColor: '#d6d2fb' }
        ]
      },
      options: { responsive: true, scales: { y: { beginAtZero: true, max: 100 } } }
    });
  }
}

/* ---------------------------- subject forms --------------------------- */

$('subForm').onsubmit = async e => {
  e.preventDefault();
  try {
    await api('/api/subjects', {
      method: 'POST',
      body: JSON.stringify({
        name: $('subName').value,
        code: $('subCode').value,
        faculty: $('subFaculty').value,
        target: $('target').value
      })
    });
    e.target.reset();
    $('target').value = 75;
    await load();
    notice('Subject added. Share its join code with your students.');
  } catch (x) {
    notice(x.message, true);
  }
};

$('joinClassForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const d = await api('/api/subjects/join', {
      method: 'POST',
      body: JSON.stringify({ code: $('joinCode').value })
    });
    $('joinCode').value = '';
    await load();
    notice('Joined ' + d.subject.name + '.');
  } catch (x) {
    notice(x.message, true);
  }
};

async function showRoster(id) {
  const s = S.subjects.find(x => x.id === id);
  try {
    const rows = await api(`/api/subjects/${id}/students`);
    $('rosterTitle').textContent = `Students · ${s.name} (${s.code})`;
    $('rosterList').innerHTML = rows.length
      ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Present</th><th>Attendance</th></tr></thead><tbody>${
          rows.map(r => {
            const below = r.conducted && r.percentage < s.target;
            const pct = r.conducted ? r.percentage + '%' : '—';
            return `<tr><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${r.attended}/${r.conducted}</td><td style="${below ? 'color:#c0392b;font-weight:700' : ''}">${pct}${below ? ' · below target' : ''}</td></tr>`;
          }).join('')
        }</tbody></table></div>`
      : `<p class="muted">No students have joined yet. Share the join code <b>${esc(s.join_code)}</b>.</p>`;
    $('rosterPanel').classList.remove('hidden');
    $('rosterPanel').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    notice(e.message, true);
  }
}

/* ------------------------------ timetable ----------------------------- */

$('ttForm').onsubmit = async e => {
  e.preventDefault();
  try {
    await api('/api/timetable', {
      method: 'POST',
      body: JSON.stringify({
        subject_id: $('ttSubject').value,
        day: $('day').value,
        start_time: $('start').value,
        end_time: $('end').value,
        room: $('room').value
      })
    });
    e.target.reset();
    await load();
    notice('Timetable entry added.');
  } catch (x) {
    notice(x.message, true);
  }
};

/* ------------------------------- planner ------------------------------ */

$('calcForm').onsubmit = e => {
  e.preventDefault();
  const s = S.subjects.find(x => String(x.id) === $('calcSubject').value);
  const t = Number($('calcTarget').value);
  const r = $('calcResult');

  if (!s || t < 1 || t > 100) return;
  if (!s.conducted) {
    r.textContent = 'No attendance recorded for this subject yet.';
    return;
  }

  if (s.percentage >= t) {
    const miss = Math.max(0, Math.floor(s.attended / (t / 100) - s.conducted));
    r.innerHTML = `<div class="big">On track</div>Approx. ${miss} consecutive class${miss === 1 ? '' : 'es'} could be missed before falling below ${t}%, assuming no other changes.`;
  } else {
    const n = Math.ceil((t * s.conducted - s.attended * 100) / (100 - t));
    r.innerHTML = `<div class="big">${Math.max(0, n)}</div>consecutive classes to attend to reach about ${t}%, assuming no future absences.`;
  }
};

/* ---------------------- live attendance: faculty ---------------------- */

function badge(status) {
  const styles = {
    present: 'background:#dcfce7;color:#166534',
    absent: 'background:#fee2e2;color:#991b1b',
    waiting: 'background:#fef3c7;color:#92400e'
  };
  const key = status || 'waiting';
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  return `<span style="${styles[key]};padding:2px 10px;border-radius:999px;font-weight:600">${label}</span>`;
}

async function loadToday() {
  const list = await api('/api/live/today');
  $('todayList').innerHTML = list.length
    ? list.map(c => `<div class="entry"><b>${esc(c.subject_name)} (${esc(c.code)})</b> · ${c.closed_at ? 'Closed' : 'Open'} <button class="primary" data-open="${c.id}">Open</button></div>`).join('')
    : '<p class="muted">No class started today.</p>';

  $('todayList').querySelectorAll('[data-open]').forEach(b => {
    b.onclick = () => openLive(Number(b.dataset.open));
  });
}

$('startForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const d = await api('/api/live/start', {
      method: 'POST',
      body: JSON.stringify({
        subject_id: $('startSubject').value,
        duration: $('startDuration').value
      })
    });
    await loadToday();
    await openLive(d.id);
  } catch (x) {
    notice(x.message, true);
  }
};

function stopLive() {
  clearInterval(S.liveTimer);
  clearInterval(S.barTimer);
  S.liveTimer = S.barTimer = null;
}

async function openLive(id) {
  stopLive();
  S.liveId = id;
  await pollLive();
  if (S.liveId === id && $('liveCodeBox').classList.contains('hidden') === false) {
    S.liveTimer = setInterval(pollLive, 2000);
    S.barTimer = setInterval(() => {
      const left = Math.max(0, S.codeEnds - Date.now());
      $('liveBar').style.width = (left / S.stepMs * 100) + '%';
    }, 200);
  }
  $('liveView').scrollIntoView({ behavior: 'smooth' });
}

async function pollLive() {
  try {
    renderLive(await api('/api/live/' + S.liveId));
  } catch (e) {
    stopLive();
    notice(e.message, true);
  }
}

function renderLive(d) {
  $('liveView').classList.remove('hidden');
  $('liveTitle').textContent = `${d.subject_name} (${d.subject_code}) · ${d.class_date}`;

  const present = d.roster.filter(r => r.status === 'present').length;
  const absent = d.roster.filter(r => r.status === 'absent').length;
  const waiting = d.roster.length - present - absent;
  $('liveCounts').textContent =
    `${present} present · ${waiting} waiting · ${absent} absent · ${d.roster.length} enrolled` +
    (d.closed ? ' · class closed' : '');

  $('liveCodeBox').classList.toggle('hidden', d.closed);
  $('endLive').classList.toggle('hidden', d.closed);

  if (!d.closed) {
    $('liveCode').textContent = d.code.slice(0, 3) + ' ' + d.code.slice(3);
    S.stepMs = d.step_ms;
    S.codeEnds = Date.now() + (d.rotates_at - d.server_time);
  }

  $('liveRoster').innerHTML = d.roster.length
    ? `<div class="tablewrap"><table><thead><tr><th>Student</th><th>Status</th><th>Correct</th></tr></thead><tbody>${
        d.roster.map(r => {
          const to = r.status === 'present' ? 'absent' : 'present';
          return `<tr><td>${esc(r.name)}<br><small class="muted">${esc(r.email)}</small></td><td>${badge(r.status)}</td><td><button class="del" data-mark="${r.id}" data-to="${to}">Mark ${to}</button></td></tr>`;
        }).join('')
      }</tbody></table></div>`
    : '<p class="muted">No students enrolled.</p>';

  $('liveRoster').querySelectorAll('[data-mark]').forEach(b => {
    b.onclick = async () => {
      try {
        await api(`/api/live/${d.id}/mark`, {
          method: 'POST',
          body: JSON.stringify({ student_id: b.dataset.mark, status: b.dataset.to })
        });
        await pollLive();
        await load();
      } catch (x) {
        notice(x.message, true);
      }
    };
  });

  if (d.closed) {
    stopLive();
    loadToday().catch(() => {});
  }
}

$('endLive').onclick = async () => {
  if (!confirm('End this class? Every student who has not checked in will be marked absent.')) return;
  try {
    await api(`/api/live/${S.liveId}/end`, { method: 'POST' });
    await pollLive();
    await load();
    notice('Class closed. Absent students were recorded.');
  } catch (x) {
    notice(x.message, true);
  }
};

/* ---------------------- live attendance: student ---------------------- */

async function refreshActive() {
  if (isFaculty()) return;
  try {
    const a = await api('/api/live/active');
    $('activeClass').textContent = a.length
      ? 'Attendance is open for: ' + a.map(x => x.subject_name).join(', ')
      : 'No class is taking attendance right now.';
  } catch {
    /* ignore; the next poll will try again */
  }
}

$('checkinForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const d = await api('/api/live/checkin', {
      method: 'POST',
      body: JSON.stringify({ code: $('code').value })
    });
    $('code').value = '';
    await load();
    await refreshActive();
    notice('Marked present for ' + d.subject_name + '.');
  } catch (x) {
    notice(x.message, true);
  }
};

/* ----------------------------- navigation ----------------------------- */

const titles = {
  overview: 'Overview',
  timetable: 'Timetable',
  subjects: 'Subjects',
  live: 'Attendance',
  planner: 'Attendance planner'
};

document.querySelectorAll('[data-page]').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    $(b.dataset.page).classList.remove('hidden');
    document.querySelectorAll('[data-page]').forEach(n =>
      n.classList.toggle('active', n === b)
    );
    $('title').textContent = titles[b.dataset.page];

    if (b.dataset.page === 'live') {
      (isFaculty() ? loadToday() : refreshActive()).catch(() => {});
    }
  };
});

enter();
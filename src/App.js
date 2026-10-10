import './App.css';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, session, setUnauthorizedHandler } from './api';

// All hospital data (queue, beds, doctors, bills, users) lives in PostgreSQL
// and is reached through server.js. This component only renders it and sends
// commands; the rules that used to live here are in db/sql/*.sql.

const THEME_STORAGE_KEY = 'hospital-theme';
const POLL_MS = 3000;          // dashboard refresh (keeps several tabs/users in sync)
const DAY_MS = 24 * 60 * 60 * 1000;

const EMPTY_DASHBOARD = {
  summary: {
    waiting: 0, admitted: 0, discharged: 0, totalBeds: 0, freeBeds: 0, freeByType: {},
    medianWaitSeconds: null, avgWaitSeconds: null, patientsServed: 0, peakLevel: null,
    emergencyDistribution: [0, 0, 0, 0, 0, 0, 0], demoImported: true,
  },
  waiting: [],
  admitted: [],
  doctors: [],
  beds: [],
};

const formatTime = (sec) => {
  let val = Math.floor(Number(sec) || 0);
  if (val < 0) val = 0;
  const h = Math.floor(val / 3600);
  const m = Math.floor((val % 3600) / 60);
  const s = val % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};
const fmtDate = (ts) => new Date(ts).toLocaleTimeString();
const dayStart = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function App() {
  const [activePanel, setActivePanel] = useState('dashboard');
  const [currentUser, setCurrentUser] = useState(() => session.load()?.user || null);
  const [authMode, setAuthMode] = useState('signin');
  const [authName, setAuthName] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [bulkAllocateCount, setBulkAllocateCount] = useState(50);
  const [regName, setRegName] = useState('');
  const [regDisease, setRegDisease] = useState('');
  const [regRoomType, setRegRoomType] = useState('General');
  const [regEmergency, setRegEmergency] = useState(3);
  const [meta, setMeta] = useState({ roomTypes: [], emergencyLevels: [] });
  const [dash, setDash] = useState(EMPTY_DASHBOARD);
  const [loaded, setLoaded] = useState(false);
  const [discharged, setDischarged] = useState([]);
  const [selectedBill, setSelectedBill] = useState(null);
  const [dischargeDayFilter, setDischargeDayFilter] = useState('today');
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_STORAGE_KEY) || 'dark');
  const [searchInput, setSearchInput] = useState('');
  const [selectedSearch, setSelectedSearch] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [searchRows, setSearchRows] = useState([]);
  const [clock, setClock] = useState(new Date().toLocaleTimeString());
  const [toasts, setToasts] = useState([]);
  const [busy, setBusy] = useState('');
  const [liveMode, setLiveMode] = useState(true);
  const [liveInflow, setLiveInflow] = useState(2);
  const [liveIntervalSec, setLiveIntervalSec] = useState(10);
  const tickInFlightRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const pushToast = useCallback((msg, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, msg, type, leaving: false }]);
    setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 300);
    }, 3000);
  }, []);

  // ---------------------------------------------------------------- session
  const endSession = useCallback((message) => {
    session.clear();
    setCurrentUser(null);
    setLoaded(false);
    setDash(EMPTY_DASHBOARD);
    if (message) pushToast(message, 'error');
  }, [pushToast]);

  useEffect(() => {
    setUnauthorizedHandler(() => endSession('Your session has expired. Please sign in again.'));
  }, [endSession]);

  // re-validate a token restored from sessionStorage
  useEffect(() => {
    if (!session.load()?.token) return;
    api.me().catch(() => {});      // a 401 triggers endSession via the handler
  }, []);

  const handleSignInSubmit = async () => {
    const email = authEmail.trim().toLowerCase();
    if (!email || !authPassword.trim()) return pushToast('Email and password are required.', 'error');
    try {
      const res = await api.signIn(email, authPassword);
      session.save({ token: res.token, user: res.user });
      setCurrentUser(res.user);
      setAuthPassword('');
      pushToast(`Welcome back ${res.user.name}`, 'success');
    } catch (err) {
      pushToast(err.message, 'error');
    }
  };

  const handleSignUpSubmit = async () => {
    const email = authEmail.trim().toLowerCase();
    if (!email || !authPassword.trim()) return pushToast('Email and password are required.', 'error');
    if (!authName.trim()) return pushToast('Please enter your full name.', 'error');
    try {
      const res = await api.signUp(authName.trim(), email, authPassword);
      setAuthName('');
      setAuthPassword('');
      setAuthMode('signin');
      pushToast(`Account created for ${res.user.name}. Please sign in.`, 'success');
    } catch (err) {
      pushToast(err.message, 'error');
    }
  };

  const handleSignOut = async () => {
    try {
      await api.signOut();
    } catch {
      // the session is being discarded anyway
    }
    endSession();
    pushToast('Signed out successfully.', 'success');
  };

  // ------------------------------------------------------------ data loading
  const refresh = useCallback(async () => {
    try {
      const data = await api.dashboard();
      setDash(data);
      setLoaded(true);
    } catch (err) {
      if (err.status !== 401) pushToast(err.message, 'error');
    }
  }, [pushToast]);

  useEffect(() => {
    if (!currentUser) return;
    api.meta().then(setMeta).catch((err) => pushToast(err.message, 'error'));
    refresh();
  }, [currentUser, refresh, pushToast]);

  useEffect(() => {
    if (!currentUser) return;
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [currentUser, refresh]);

  // Live mode: each tick is one atomic database transaction (arrivals,
  // due discharges, allocations) — see pkg_simulation.tick.
  useEffect(() => {
    if (!currentUser || !loaded || !liveMode) return;
    const cadence = Math.max(2, Number(liveIntervalSec) || 5);
    const inflow = Math.max(1, Math.min(20, Number(liveInflow) || 6));
    const timer = setInterval(async () => {
      if (tickInFlightRef.current || document.hidden) return;
      tickInFlightRef.current = true;
      try {
        await api.tick(inflow);
        await refresh();
      } catch (err) {
        if (err.status !== 401) pushToast(err.message, 'error');
      } finally {
        tickInFlightRef.current = false;
      }
    }, cadence * 1000);
    return () => clearInterval(timer);
  }, [currentUser, loaded, liveMode, liveInflow, liveIntervalSec, refresh, pushToast]);

  // ------------------------------------------------------------ derived data
  const { summary, waiting: waitingList, admitted, doctors, beds } = dash;
  const nextPatient = waitingList[0] || null;
  const HOSPITAL_BEDS = summary.totalBeds;
  const freeBeds = summary.freeBeds;
  const occupiedBeds = HOSPITAL_BEDS - freeBeds;
  const occupancyPct = HOSPITAL_BEDS ? Math.round((occupiedBeds / HOSPITAL_BEDS) * 100) : 0;
  const roomTypes = meta.roomTypes.map((r) => r.code);
  const levels = meta.emergencyLevels.length
    ? meta.emergencyLevels
    : [1, 2, 3, 4, 5, 6, 7].map((level) => ({ level, label: String(level) }));
  const emerLabel = (l) => meta.emergencyLevels.find((e) => e.level === l)?.label || l;
  const displayName = (p) => `[${p.initials}] ${p.name}`;
  const roomBadgeClass = (roomType) => `room-badge room-${String(roomType).toLowerCase()}`;

  const criticalPatients = [...waitingList, ...admitted].filter((p) => p.emergencyLevel >= 6).slice(0, 8);
  const dist = summary.emergencyDistribution || [];
  const maxDist = Math.max(...dist, 1);
  const peak = summary.peakLevel;

  const todayStart = dayStart(Date.now());
  const daySections = useMemo(() => {
    const label = (ts) => new Date(ts).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
    return [
      { key: 'today', label: 'Today', from: todayStart, to: todayStart + DAY_MS },
      { key: 'yesterday', label: 'Yesterday', from: todayStart - DAY_MS, to: todayStart },
      ...Array.from({ length: 5 }, (_, i) => {
        const from = todayStart - (i + 2) * DAY_MS;
        return { key: `d-${from}`, label: label(from), from, to: from + DAY_MS };
      }),
    ];
  }, [todayStart]);
  const activeDaySection = daySections.find((s) => s.key === dischargeDayFilter) || daySections[0];

  // discharge history for the selected local day; refetched when the total changes
  useEffect(() => {
    if (!currentUser || activePanel !== 'discharged') return;
    let alive = true;
    api.discharges(activeDaySection.from, activeDaySection.to)
      .then((res) => { if (alive) setDischarged(res.discharges); })
      .catch((err) => { if (alive && err.status !== 401) pushToast(err.message, 'error'); });
    return () => { alive = false; };
  }, [currentUser, activePanel, activeDaySection.from, activeDaySection.to, summary.discharged, pushToast]);

  // search: prefix suggestions + substring matches, debounced
  const activeSearch = (selectedSearch || searchInput).trim();
  useEffect(() => {
    if (!currentUser) return;
    const prefix = searchInput.trim();
    if (!prefix) {
      setSuggestions([]);
      setSearchRows([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const [s, r] = await Promise.all([api.suggest(prefix), api.search(activeSearch)]);
        if (!alive) return;
        setSuggestions(s.suggestions);
        setSearchRows(r.results);
      } catch (err) {
        if (alive && err.status !== 401) pushToast(err.message, 'error');
      }
    }, 200);
    return () => { alive = false; clearTimeout(timer); };
  }, [currentUser, searchInput, activeSearch, pushToast]);

  // ----------------------------------------------------------------- actions
  const runAction = async (key, fn) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      pushToast(err.message, 'error');
    } finally {
      setBusy('');
      refresh();
    }
  };

  const resetRegisterForm = () => {
    setRegName('');
    setRegDisease('');
    setRegRoomType(roomTypes[0] || 'General');
    setRegEmergency(3);
  };

  const registerPatient = () => {
    const name = regName.trim();
    if (!name) return pushToast('Name cannot be empty!', 'error');
    if (!regDisease.trim()) return pushToast('Please enter disease/suffering.', 'error');
    return runAction('register', async () => {
      const { patient } = await api.registerPatient({
        name,
        disease: regDisease.trim(),
        preferredRoom: regRoomType,
        emergencyLevel: Number(regEmergency),
      });
      resetRegisterForm();
      pushToast(`Patient "${patient.name}" registered (ID: ${patient.id}, Level ${patient.emergencyLevel})`, 'success');
    });
  };

  const allocateBed = () => runAction('allocate', async () => {
    const { patient: p } = await api.allocateNext();
    pushToast(`${displayName(p)} -> Bed ${p.bedNo} (${p.roomType}) | Wait: ${formatTime(p.waitSeconds)} | ${p.emergencyMsg}`, 'success');
  });

  const allocateMultipleBeds = () => runAction('bulk', async () => {
    const requested = Math.max(1, Math.min(50, Number(bulkAllocateCount) || 50));
    const { allocated } = await api.allocateBulk(requested);
    pushToast(`${allocated} patients allocated successfully.`, allocated ? 'success' : 'error');
  });

  const dischargePatient = (id) => runAction(`discharge-${id}`, async () => {
    const { patient: p } = await api.discharge(id);
    pushToast(`Patient ${displayName(p)} discharged. Bed ${p.bedNo} freed. Bill: Rs ${p.bill?.total ?? '—'}`, 'success');
  });

  const addIncoming = () => runAction('arrivals', async () => {
    const { arrived } = await api.addArrivals(Math.max(1, Number(liveInflow) || 3));
    pushToast(`${arrived} incoming patient(s) added to the queue.`, 'info');
  });

  const importDemoPatients = () => runAction('demo', async () => {
    const res = await api.importDemo();
    pushToast(`${res.imported} demo patients imported successfully.`, 'success');
  });

  const toastStack = (
    <div id="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type} ${t.leaving ? 'fade' : ''}`}>
          <span>{t.type === 'success' ? '✓' : t.type === 'error' ? '✗' : 'ℹ'}</span>
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );

  if (!currentUser) {
    const submit = authMode === 'signup' ? handleSignUpSubmit : handleSignInSubmit;
    return (
      <>
        {toastStack}
        <div className={`app-shell auth-shell ${theme === 'light' ? 'theme-light' : ''}`}>
          <form className="auth-card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="logo auth-logo">
              <div className="logo-icon"><span className="logo-heart">✚</span></div>
              3D <span>MULTISPECIALIST HOSPITAL</span>
            </div>
            <h2>{authMode === 'signup' ? 'Create account' : 'Welcome back'}</h2>
            <p className="auth-sub">Sign in to access the hospital dashboard.</p>
            {authMode === 'signup' && (
              <input value={authName} onChange={(e) => setAuthName(e.target.value)} placeholder="Full name" autoComplete="name" />
            )}
            <input value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} placeholder="Email address" autoComplete="email" />
            <input
              type="password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              placeholder={authMode === 'signup' ? 'Password (min. 6 characters)' : 'Password'}
              autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
            />
            <button type="submit" className="btn btn-primary">
              {authMode === 'signup' ? 'Sign Up' : 'Sign In'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setAuthMode((m) => (m === 'signup' ? 'signin' : 'signup'))}>
              {authMode === 'signup' ? 'Already have an account? Sign In' : 'New here? Create account'}
            </button>
          </form>
        </div>
      </>
    );
  }

  return (
    <div className={`app-shell ${theme === 'light' ? 'theme-light' : ''}`}>
      <header>
        <div className="logo">
          <div className="logo-icon">
            <span className="logo-heart">✚</span>
          </div>
          3D <span>MULTISPECIALIST HOSPITAL</span>
        </div>
        <div className="header-stats">
          <div className="hstat"><strong>{currentUser.name}</strong>{currentUser.email}</div>
          <button className="btn btn-ghost btn-sm" onClick={() => setTheme((old) => (old === 'dark' ? 'light' : 'dark'))}>
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={handleSignOut}>Sign Out</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setLiveMode((v) => !v)}>
            {liveMode ? 'Live: ON' : 'Live: OFF'}
          </button>
          <div className="hstat"><strong>{summary.waiting}</strong>Waiting</div>
          <div className="hstat"><strong>{summary.admitted}</strong>Admitted</div>
          <div className="hstat"><strong>{freeBeds}</strong>Free Beds</div>
          <div className="hstat live-clock"><span className="live-dot"></span>{clock}</div>
        </div>
      </header>

      <div className="layout">
        <nav>
          <div className="nav-label">Navigation</div>
          {['dashboard', 'register', 'waiting', 'admitted', 'discharged', 'beds', 'stats', 'search', 'doctors', 'about'].map((id, i) => (
            <button key={id} className={`nav-btn ${activePanel === id ? 'active' : ''}`} onClick={() => setActivePanel(id)}>
              <span className="icon">{['◈', '+', '⏳', '🛏', '✓', '⊞', '◎', '⌕', '🩺', 'ℹ'][i]}</span>
              {['Dashboard', 'Register Patient', 'Waiting Queue', 'Admitted', 'Discharged', 'Bed Map', 'Statistics', 'Search', 'Doctors', 'About Us'][i]}
              {id === 'waiting' && <span className="nav-badge red">{summary.waiting}</span>}
              {id === 'admitted' && <span className="nav-badge green">{summary.admitted}</span>}
              {id === 'discharged' && <span className="nav-badge blue">{summary.discharged}</span>}
            </button>
          ))}
        </nav>

        <main>
          {activePanel === 'dashboard' && (
            <div className="panel active">
              <div className="page-title">Dashboard</div>

              <div className="stats-grid">
                <div className="stat-card cyan"><div className="stat-label">FREE BEDS</div><div className="stat-val">{freeBeds}</div><div className="stat-sub">of {HOSPITAL_BEDS} total</div></div>
                <div className="stat-card red"><div className="stat-label">WAITING</div><div className="stat-val">{summary.waiting}</div><div className="stat-sub">in queue</div></div>
                <div className="stat-card green"><div className="stat-label">ADMITTED</div><div className="stat-val">{summary.admitted}</div><div className="stat-sub">in beds</div></div>
                <div className="stat-card yellow"><div className="stat-label">DISCHARGED</div><div className="stat-val">{summary.discharged}</div><div className="stat-sub">total history</div></div>
              </div>

              <div className="two-col">
                <div className="card next-queue-card">
                  <div className="card-title">Next In Queue</div>
                  {nextPatient ? (
                    <div className="next-queue-body">
                      <div className="next-row next-row-top">
                        <div>
                          <div className="next-name">{displayName(nextPatient)}</div>
                          <div className="next-meta">ID: {nextPatient.id}</div>
                        </div>
                        <span className={`badge badge-${nextPatient.emergencyLevel}`}>LVL {nextPatient.emergencyLevel} - {emerLabel(nextPatient.emergencyLevel)}</span>
                      </div>
                      <div className="next-wait">Waiting: <span>{formatTime((Date.now() - nextPatient.arrivalTime) / 1000)}</span></div>
                      <div className="next-note">{nextPatient.emergencyMsg}</div>
                    </div>
                  ) : (
                    <div className="empty"><span className="empty-icon">⏳</span>Queue is empty</div>
                  )}
                  <div className="action-row">
                    <button className="btn btn-primary" onClick={allocateBed} disabled={!!busy}>Allocate Bed -&gt;</button>
                  </div>
                </div>

                <div className="card">
                  <div className="card-title">Critical Patients (Level 6+)</div>
                  {criticalPatients.length ? criticalPatients.map((p) => (
                    <div key={p.id} className="crit-row">
                      <span>{displayName(p)}</span>
                      <span className={p.bedNo > 0 ? 'ok' : 'warn'}>{p.bedNo > 0 ? `Bed ${p.bedNo}` : 'WAITING'}</span>
                    </div>
                  )) : <div className="empty"><span className="empty-icon">✓</span>No critical patients</div>}
                </div>
              </div>
              <div className="card doctor-overview">
                <div className="card-title">Doctor Availability Overview</div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Doctor</th><th>Specialty</th><th>Current</th><th>Capacity</th></tr></thead>
                    <tbody>
                      {doctors.map((doctor) => (
                        <tr key={doctor.id}>
                          <td>{doctor.name}</td>
                          <td>{doctor.specialty}</td>
                          <td>{doctor.currentLoad}</td>
                          <td>{doctor.maxPatients}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activePanel === 'register' && (
            <div className="panel active">
              <div className="page-title">Register Patient</div>
              <div className="card">
                <div className="card-title">Patient Information</div>
                <div className="form-grid">
                  <div className="form-group full">
                    <label>Full Name</label>
                    <input value={regName} onChange={(e) => setRegName(e.target.value)} placeholder="Enter patient full name" maxLength={100} />
                  </div>
                  <div className="form-group full">
                    <label>Disease / Suffering</label>
                    <input value={regDisease} onChange={(e) => setRegDisease(e.target.value)} placeholder="e.g. High fever, chest pain..." maxLength={120} />
                  </div>
                  <div className="form-group full">
                    <label>Preferred Room Type</label>
                    <select value={regRoomType} onChange={(e) => setRegRoomType(e.target.value)}>
                      {roomTypes.map((type) => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group emer-group">
                    <label>Emergency Level</label>
                    <div className="emer-options">
                      {levels.map(({ level, label }) => (
                        <div className="emer-opt" key={level}>
                          <input id={`e${level}`} type="radio" name="emer" checked={regEmergency === level} onChange={() => setRegEmergency(level)} />
                          <label htmlFor={`e${level}`}>{level} - {label}</label>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="action-row">
                  <button className="btn btn-primary" onClick={registerPatient} disabled={!!busy}>Register &amp; Add to Queue</button>
                  <button className="btn btn-ghost" onClick={importDemoPatients} disabled={summary.demoImported || !!busy}>
                    {summary.demoImported ? 'Demo Patients Imported' : 'Import Demo Patients'}
                  </button>
                  <button className="btn btn-ghost" onClick={resetRegisterForm}>Clear</button>
                </div>
              </div>
            </div>
          )}

          {activePanel === 'waiting' && (
            <div className="panel active">
              <div className="page-title">Waiting Queue</div>
              <div className="action-row compact">
                <button className="btn btn-primary" onClick={allocateBed} disabled={!!busy}>Allocate Bed to Next -&gt;</button>
                <input
                  className="bulk-input"
                  type="number"
                  min="1"
                  max="50"
                  value={bulkAllocateCount}
                  onChange={(e) => setBulkAllocateCount(e.target.value)}
                />
                <button className="btn btn-ghost" onClick={allocateMultipleBeds} disabled={!!busy}>Allocate Bulk (Max 50)</button>
                <label className="inline-ctl">Inflow</label>
                <input
                  className="bulk-input"
                  type="number"
                  min="1"
                  max="20"
                  value={liveInflow}
                  onChange={(e) => setLiveInflow(e.target.value)}
                />
                <label className="inline-ctl">Every(s)</label>
                <input
                  className="bulk-input"
                  type="number"
                  min="2"
                  max="30"
                  value={liveIntervalSec}
                  onChange={(e) => setLiveIntervalSec(e.target.value)}
                />
                <button className="btn btn-ghost" onClick={addIncoming} disabled={!!busy}>Add Incoming Now</button>
              </div>
              <div className="card">
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>#</th><th>ID</th><th>Name</th><th>Emergency</th><th>Emergency Note</th><th>Waiting Since</th><th>Wait Time</th></tr></thead>
                    <tbody>
                      {waitingList.map((p) => (
                        <tr key={p.id}>
                          <td>{p.queuePosition}</td><td>{p.id}</td><td className="name-cell">{displayName(p)}</td>
                          <td><span className={`badge badge-${p.emergencyLevel}`}>LVL {p.emergencyLevel} - {emerLabel(p.emergencyLevel)}</span></td><td>{p.emergencyMsg}</td>
                          <td>{fmtDate(p.arrivalTime)}</td><td>{formatTime((Date.now() - p.arrivalTime) / 1000)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!waitingList.length && <div className="empty"><span className="empty-icon">✓</span>No patients waiting</div>}
              </div>
            </div>
          )}

          {activePanel === 'admitted' && (
            <div className="panel active">
              <div className="page-title">Admitted Patients</div>
              <div className="card">
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>ID</th><th>Name</th><th>Disease</th><th>Specialty</th><th>Doctor</th><th>Bed</th><th>Room</th><th>Emergency</th><th>Emergency Note</th><th>Admitted At</th><th>Action</th></tr></thead>
                    <tbody>
                      {admitted.map((p) => (
                        <tr key={p.id}>
                          <td>{p.id}</td><td className="name-cell">{displayName(p)}</td><td>{p.disease}</td><td>{p.specialty}</td><td>{p.doctorName}</td><td>Bed {p.bedNo}</td><td><span className={roomBadgeClass(p.roomType)}>{p.roomType}</span></td>
                          <td><span className={`badge badge-${p.emergencyLevel}`}>LVL {p.emergencyLevel}</span></td><td>{p.emergencyMsg}</td>
                          <td>{fmtDate(p.bedAllocTime)}</td>
                          <td><button className="btn btn-danger btn-sm" onClick={() => dischargePatient(p.id)} disabled={!!busy}>Discharge</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!admitted.length && <div className="empty"><span className="empty-icon">🛏</span>No patients currently admitted</div>}
              </div>
            </div>
          )}

          {activePanel === 'discharged' && (
            <div className="panel active">
              <div className="page-title">Discharge History</div>
              <div className="card">
                <div className="action-row compact">
                  {daySections.map((section) => (
                    <button
                      key={section.key}
                      className={`btn btn-sm ${dischargeDayFilter === section.key ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => {
                        setDischargeDayFilter(section.key);
                        setSelectedBill(null);
                      }}
                    >
                      {section.label}
                    </button>
                  ))}
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>ID</th><th>Name</th><th>Disease</th><th>Specialty</th><th>Doctor</th><th>Bed Was</th><th>Room</th><th>Emergency</th><th>Emergency Note</th><th>Wait Time</th><th>Discharged</th><th>Bill</th></tr></thead>
                    <tbody>
                      {discharged.map((p) => (
                        <Fragment key={p.id}>
                          <tr>
                            <td>{p.id}</td><td className="name-cell">{displayName(p)}</td><td>{p.disease}</td><td>{p.specialty}</td><td>{p.doctorName}</td><td>Bed {p.bedNo}</td><td><span className={roomBadgeClass(p.roomType)}>{p.roomType}</span></td>
                            <td><span className={`badge badge-${p.emergencyLevel}`}>LVL {p.emergencyLevel}</span></td><td>{p.emergencyMsg}</td>
                            <td>{formatTime(p.waitSeconds)}</td><td>{fmtDate(p.dischargeTime)}</td>
                            <td>
                              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedBill((old) => (old === p.id ? null : p.id))}>
                                {selectedBill === p.id ? 'Hide Bill' : 'View Bill'}
                              </button>
                            </td>
                          </tr>
                          {selectedBill === p.id && p.bill && (
                            <tr>
                              <td colSpan="12">
                                <div className="bill-card">
                                  <div className="card-title">Patient Bill</div>
                                  <div className="bill-grid">
                                    <div>Patient: <strong>{displayName(p)}</strong></div>
                                    <div>Disease: <strong>{p.disease}</strong></div>
                                    <div>Doctor: <strong>{p.doctorName}</strong></div>
                                    <div>Room: <strong>{p.bill.roomType}</strong></div>
                                    <div>Stay: <strong>{p.bill.stayHours >= 24 ? `${(p.bill.stayHours / 24).toFixed(1)} day(s)` : `${p.bill.stayHours} hour(s)`}</strong></div>
                                    <div>Room Charge: <strong>Rs {p.bill.roomCharge}</strong></div>
                                    <div>Emergency Charge: <strong>Rs {p.bill.emergencyCharge}</strong></div>
                                    <div>Doctor Fee: <strong>Rs {p.bill.doctorFee}</strong></div>
                                    <div>Nursing Charge: <strong>Rs {p.bill.nursingCharge}</strong></div>
                                    <div>Pharmacy Charge: <strong>Rs {p.bill.pharmacyCharge}</strong></div>
                                    <div>Diagnostics: <strong>Rs {p.bill.diagnosticsCharge}</strong></div>
                                    <div>Procedure Charge: <strong>Rs {p.bill.procedureCharge}</strong></div>
                                    <div>Treatment Charge: <strong>Rs {p.bill.treatmentCharge}</strong></div>
                                    <div>Service Charge: <strong>Rs {p.bill.serviceCharge}</strong></div>
                                    <div>Subtotal: <strong>Rs {p.bill.subtotal}</strong></div>
                                    <div>GST (5%): <strong>Rs {p.bill.gst}</strong></div>
                                    <div>Insurance Discount: <strong>Rs {p.bill.insuranceDiscount}</strong></div>
                                    <div className="bill-total">Total: Rs {p.bill.total}</div>
                                  </div>
                                  {p.feedback && (
                                    <div className="feedback-form">
                                      <div className="card-title">Discharge Feedback</div>
                                      <div className="feedback-grid">
                                        <div className="feedback-field">
                                          <label>Overall Rating (1-5)</label>
                                          <input value={p.feedback.rating} readOnly disabled />
                                        </div>
                                        <div className="feedback-field">
                                          <label>Complaint Type</label>
                                          <input value={p.feedback.complaintType} readOnly disabled />
                                        </div>
                                        <div className="feedback-field full">
                                          <label>Complaint Details</label>
                                          <textarea value={p.feedback.complaintText} readOnly disabled />
                                        </div>
                                        <div className="feedback-field full">
                                          <label>Suggested Improvement</label>
                                          <textarea value={p.feedback.suggestion} readOnly disabled />
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!discharged.length && <div className="empty"><span className="empty-icon">◎</span>No discharge records for {activeDaySection.label}</div>}
              </div>
            </div>
          )}

          {activePanel === 'beds' && (
            <div className="panel active">
              <div className="page-title">Bed Map</div>
              <div className="stats-grid bed-stats">
                <div className="stat-card green"><div className="stat-label">FREE</div><div className="stat-val">{freeBeds}</div></div>
                <div className="stat-card red"><div className="stat-label">OCCUPIED</div><div className="stat-val">{occupiedBeds}</div></div>
                <div className="stat-card cyan"><div className="stat-label">OCCUPANCY %</div><div className="stat-val">{occupancyPct}%</div></div>
              </div>
              <div className="stats-grid bed-stats room-split">
                {roomTypes.map((type) => (
                  <div className="stat-card" key={type}>
                    <div className="stat-label">{type.toUpperCase()} FREE</div>
                    <div className="stat-val">{summary.freeByType[type] ?? 0}</div>
                  </div>
                ))}
              </div>
              <div className="card">
                <div className="bed-grid full">
                  {beds.map((bed) => (
                    <div key={bed.bedNo} className={`bed-cell ${bed.occupied ? 'occupied' : 'free'}`}>
                      {bed.occupied ? '🔴' : '🟢'}<div>{bed.bedNo}</div><small>{bed.roomType}</small>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activePanel === 'stats' && (
            <div className="panel active">
              <div className="page-title">Statistics</div>
              <div className="two-col">
                <div className="card">
                  <div className="card-title">Waiting Time Analytics</div>
                  <div className="stat-row"><span className="stat-row-label">Median Wait Time</span><span className="stat-row-val">{summary.patientsServed ? formatTime(summary.medianWaitSeconds) : '—'}</span></div>
                  <div className="stat-row"><span className="stat-row-label">Average Wait Time</span><span className="stat-row-val">{summary.patientsServed ? formatTime(summary.avgWaitSeconds) : '—'}</span></div>
                  <div className="stat-row"><span className="stat-row-label">Total Patients Served</span><span className="stat-row-val">{summary.patientsServed}</span></div>
                  <div className="stat-row"><span className="stat-row-label">Peak Emergency Level</span><span className="stat-row-val">{peak ? `Level ${peak} - ${emerLabel(peak)}` : '—'}</span></div>
                </div>
                <div className="card">
                  <div className="card-title">Emergency Distribution</div>
                  {dist.map((c, i) => (
                    <div key={i} className="dist-row">
                      <span className="dist-label">LVL {i + 1}</span>
                      <div className="dist-track"><div className="dist-fill" style={{ width: `${(c / maxDist) * 100}%` }}></div></div>
                      <span className="dist-count">{c}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activePanel === 'search' && (
            <div className="panel active">
              <div className="page-title">Patient Search</div>
              <div className="card">
                <div className="card-title">Search By Name Prefix</div>
                <div className="search-box">
                  <input
                    value={searchInput}
                    onChange={(e) => {
                      setSearchInput(e.target.value);
                      setSelectedSearch('');
                    }}
                    placeholder="Type name prefix..."
                  />
                  {!!searchInput.trim() && !!suggestions.length && !selectedSearch && (
                    <div className="suggestions">
                      {suggestions.map((m) => (
                        <div key={m} className="suggestion-item" onClick={() => { setSelectedSearch(m); setSearchInput(m); }}>
                          <span className="match">{m.slice(0, searchInput.trim().length)}</span>{m.slice(searchInput.trim().length)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {!activeSearch ? null : searchRows.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>ID</th><th>Name</th><th>Disease</th><th>Doctor</th><th>Status</th><th>Room</th><th>Emergency</th><th>Bed</th></tr></thead>
                      <tbody>
                        {searchRows.map((p) => (
                          <tr key={p.id}>
                            <td>{p.id}</td><td className="name-cell">{displayName(p)}</td><td>{p.disease}</td><td>{p.doctorName}</td><td>{p.status}</td><td>{p.roomType || p.preferredRoom}</td>
                            <td><span className={`badge badge-${p.emergencyLevel}`}>LVL {p.emergencyLevel}</span></td>
                            <td>{p.bedNo > 0 ? `Bed ${p.bedNo}` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty"><span className="empty-icon">◎</span>No patients found</div>
                )}
              </div>
            </div>
          )}

          {activePanel === 'doctors' && (
            <div className="panel active">
              <div className="page-title">Doctors</div>
              <div className="card">
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Doctor</th><th>Specialty</th><th>Assigned</th><th>Max Capacity</th><th>Available Slots</th></tr></thead>
                    <tbody>
                      {doctors.map((doctor) => (
                        <tr key={doctor.id}>
                          <td>{doctor.name}</td>
                          <td>{doctor.specialty}</td>
                          <td>{doctor.currentLoad}</td>
                          <td>{doctor.maxPatients}</td>
                          <td>{doctor.availableSlots}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activePanel === 'about' && (
            <div className="panel active">
              <div className="page-title">About Us</div>
              <div className="card" style={{ marginBottom: '20px' }}>
                <div className="card-title">Welcome to 3D MULTISPECIALIST HOSPITAL</div>
                <p className="about-text">3D MULTISPECIALIST HOSPITAL is a premier multi-specialty healthcare institution dedicated to providing top-tier medical services. With a heavy focus on emergency response, critical care, and patient-first methodologies, we strive to achieve medical excellence in every facet of treatment.</p>

                <h3 style={{ marginTop: '20px', marginBottom: '10px', fontSize: '1rem' }}>Our History</h3>
                <p className="about-text">The hospital started as a small private clinic and has since blossomed into a monumental 300-bed facility equipped with the latest medical technology. Through relentless growth, we have expanded our capacity while successfully decreasing wait-times, setting a new benchmark for proactive and empathetic patient care.</p>

                <h3 style={{ marginTop: '20px', marginBottom: '10px', fontSize: '1rem' }}>Contact & Location</h3>
                <div className="two-col" style={{ marginTop: '10px', lineHeight: '1.6' }}>
                  <div>
                    <strong>Phone Number:</strong><br />
                    +91 98765 43210 <br />
                    +91 01234 56789 (Emergency)
                  </div>
                  <div>
                    <strong>Email:</strong><br />
                    contact@3dhospital.com<br />
                    emergency@3dhospital.com
                  </div>
                  <div>
                    <strong>Address:</strong><br />
                    123 Prime Healthcare Avenue,<br />
                    Medical Hub District,<br />
                    Mumbai, Maharashtra - 400001
                  </div>
                  <div>
                    <strong>Operating Hours:</strong><br />
                    Emergency & ICU: 24/7<br />
                    OPD: 8:00 AM - 8:00 PM
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {toastStack}
    </div>
  );
}

export default App;

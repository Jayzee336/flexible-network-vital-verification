import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import axios from 'axios';
import Dexie from 'dexie';
import { Activity, Baby, BarChart3, BriefcaseMedical, Check, ChevronDown, CircleUserRound, Cloud, CloudOff, FilePlus2, HeartPulse, Home, LogOut, Menu, Plus, Printer, RefreshCw, Search, ShieldCheck, Syringe, Users, Wifi, WifiOff, X } from 'lucide-react';
import './bootstrap';

const api = axios.create({ baseURL: '/api/v1', headers: { Accept: 'application/json' } });
const db = new Dexie('him-offline');
db.version(1).stores({ queue: '++id, client_transaction_id, created_at' });
db.version(2).stores({ queue: '++id, client_transaction_id, created_at', patients: 'id, patient_number, philhealth_id', households: 'id, household_code', codes: 'id, code', schedules: 'id, vaccine_code', encounters: 'id, encountered_at', immunizations: 'id, patient_id, vaccine_schedule_id, administered_at' });
const toLocalDateInput = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
const today = toLocalDateInput();
const emptyPatient = { first_name: '', middle_name: '', last_name: '', suffix: '', date_of_birth: '', sex_at_birth: 'unknown', patient_number: '', philhealth_id: '', contact_number: '', email: '', guardian_name: '', guardian_relationship: '', guardian_contact_number: '', household_id: '', is_household_head: false };
const nav = [
  { id: 'overview', label: 'Overview', icon: Home }, { id: 'patients', label: 'Patients', icon: Users },
  { id: 'encounters', label: 'Encounters', icon: HeartPulse }, { id: 'immunizations', label: 'Immunizations', icon: Syringe },
  { id: 'sync', label: 'Offline sync', icon: Cloud }, { id: 'reports', label: 'FHSIS reports', icon: BarChart3 },
];
const uuid = () => crypto.randomUUID();
const fullName = (patient) => [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ');
async function readCachedList(path, table, params = {}) {
  try {
    const { data } = await api.get(path, { params });
    const records = Array.isArray(data) ? data : (data.data || []);
    if (records.length) await db[table].bulkPut(records);
    return records;
  } catch {
    return db[table].toArray();
  }
}

function App() {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('him_token'));
  const [online, setOnline] = useState(navigator.onLine);
  const [page, setPage] = useState('overview');
  const [queueCount, setQueueCount] = useState(0);
  const [toast, setToast] = useState('');
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    document.title = 'Flexible Network for Vital Health Verification';
  }, []);
  useEffect(() => {
    const onlineHandler = () => setOnline(true), offlineHandler = () => setOnline(false);
    window.addEventListener('online', onlineHandler); window.addEventListener('offline', offlineHandler);
    return () => { window.removeEventListener('online', onlineHandler); window.removeEventListener('offline', offlineHandler); };
  }, []);
  useEffect(() => { db.queue.count().then(setQueueCount); }, []);
  useEffect(() => {
    if (!token) return;
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
    api.get('/auth/me').then(({ data }) => setUser(data.user)).catch(() => { localStorage.removeItem('him_token'); setToken(null); });
  }, [token]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);

  const login = async (credentials) => {
    const { data } = await api.post('/auth/login', credentials);
    localStorage.setItem('him_token', data.token); api.defaults.headers.common.Authorization = `Bearer ${data.token}`;
    setToken(data.token); setUser(data.user);
  };
  const logout = async () => {
    try { await api.post('/auth/logout'); } catch { /* local logout must work offline */ }
    localStorage.removeItem('him_token'); delete api.defaults.headers.common.Authorization; setToken(null); setUser(null);
  };
  const queueTransaction = async (entity_type, payload) => {
    const transaction = { client_transaction_id: uuid(), client_entity_id: payload.patient_uuid || payload.client_encounter_id || payload.client_record_id || uuid(), entity_type, operation: 'create', payload, created_at: new Date().toISOString() };
    await db.queue.add(transaction); setQueueCount(await db.queue.count()); setToast('Saved to this device and queued for sync.');
  };
  const syncQueue = async () => {
    if (!online) { setToast('Connect to the internet before syncing.'); return; }

    const queued = await db.queue.orderBy('id').toArray();
    if (!queued.length) { setToast('Your offline queue is clear.'); return; }

    let requestFailed = false;
    let failedTransactions = 0;
    let processedTransactions = 0;

    for (let offset = 0; offset < queued.length; offset += 100) {
      const batch = queued.slice(offset, offset + 100);

      try {
        const deviceId = localStorage.getItem('him_device_id') || (() => {
          const id = uuid();
          localStorage.setItem('him_device_id', id);
          return id;
        })();

        const { data } = await api.post('/sync', {
          client_device_id: deviceId,
          transactions: batch.map(({ client_transaction_id, client_entity_id, entity_type, operation, payload }) => ({
            client_transaction_id,
            client_entity_id,
            entity_type,
            operation,
            payload,
          })),
        });

        if (!Array.isArray(data.results)) {
          throw new Error('The server returned an unexpected synchronization response.');
        }

        const completed = data.results
          .filter((result) => ['processed', 'completed'].includes(result.status))
          .map((result) => result.client_transaction_id);

        failedTransactions += data.results.filter((result) => result.status === 'failed').length;
        processedTransactions += completed.length;

        if (completed.length) {
          await db.queue.where('client_transaction_id').anyOf(completed).delete();
        }
      } catch (error) {
        requestFailed = true;
        setToast(error.response?.data?.message || error.message || 'Sync stopped. Items remain safely queued.');
        break;
      }
    }

    setQueueCount(await db.queue.count());

    if (!requestFailed) {
      if (failedTransactions > 0) {
        setToast(`Synced ${processedTransactions} item(s). ${failedTransactions} item(s) need review and remain queued.`);
      } else {
        setToast(`Successfully synchronized ${processedTransactions} item(s).`);
      }
    }
  };

  if (!user) return <Login onLogin={login} />;
  const visibleNav = user.role === 'super_admin' ? [...nav, { id: 'staff', label: 'Staff accounts', icon: BriefcaseMedical }] : nav;
  return <div className="min-h-screen bg-[#f5f7f6] text-slate-800">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><HeartPulse size={22} /></div><div><strong>Flexible Network for Vital Health Verification </strong><small>Barangay Health Center</small></div><button className="mobile-close" onClick={() => setMobileNav(false)}><X size={18}/></button></div>
      <div className="nav-caption">WORKSPACE</div>
      <nav>{visibleNav.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => { setPage(id); setMobileNav(false); }} className={`nav-item ${page === id ? 'active' : ''}`}><Icon size={18}/><span>{label}</span>{id === 'sync' && queueCount > 0 && <span className="nav-count">{queueCount}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="privacy-card"><ShieldCheck size={18}/><div><b>Protected records</b><span>Encrypted connection</span></div></div><div className="user-mini"><div className="avatar">{user.name.slice(0,1)}</div><div className="user-mini-text"><b>{user.name}</b><span>{user.role.replace('_', ' ')}</span></div><button title="Log out" onClick={logout}><LogOut size={17}/></button></div></div>
    </aside>
    {mobileNav && <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation"/>}
    <main className="main-shell">
      <header className="topbar"><button className="menu-button" onClick={() => setMobileNav(true)}><Menu size={20}/></button><div className="breadcrumb">HIM <span>/</span> <b>{visibleNav.find((item) => item.id === page)?.label}</b></div><div className="top-actions"><button className={`status-pill ${online ? 'online' : 'offline'}`} title="Toggle simulated connectivity" onClick={() => setOnline((current) => !current)}><span className="status-dot"/>{online ? 'Online' : 'Offline'}</button><span className="login-chip"><CircleUserRound size={16}/>{user.role === 'super_admin' ? 'Administrator' : 'Health worker'}</span><button className="logout-mobile" onClick={logout}><LogOut size={17}/></button></div></header>
      <div className="page-content">
        <div className="page-view" key={page}>
        {page === 'overview' && <Overview user={user} queueCount={queueCount} online={online} setPage={setPage} />}
        {page === 'patients' && <Patients online={online} notify={setToast} queueTransaction={queueTransaction} />}
        {page === 'encounters' && <Encounters online={online} notify={setToast} queueTransaction={queueTransaction} />}
        {page === 'immunizations' && <Immunizations online={online} notify={setToast} queueTransaction={queueTransaction} />}
        {page === 'sync' && <SyncDashboard online={online} count={queueCount} refresh={syncQueue} />}
        {page === 'reports' && <Reports />}
        {page === 'staff' && user.role === 'super_admin' && <Staff />}
      
        </div>
      </div>
      <footer className="footer">HIM · Health Information System <span>Confidential patient information</span></footer>
    </main>
    {toast && <div className="toast"><Check size={17}/>{toast}<button onClick={() => setToast('')}><X size={16}/></button></div>}
  </div>;
}

function Login({ onLogin }) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (event) => { event.preventDefault(); setBusy(true); setError(''); try { await onLogin({ email, password, device_name: 'HIM clinic workstation' }); } catch { setError('We could not verify these credentials. Check your email and password.'); } finally { setBusy(false); } };
  return <div className="login-page"><div className="login-side"><div className="login-brand"><div className="brand-mark"><HeartPulse size={24}/></div>Flexible Network for Vital Health Verification</div><div className="login-hero"><div className="eyebrow light"><span/>BARANGAY HEALTH CENTER</div><h1>Better records.<br/><em>Healthier</em> communities.</h1><p>A secure workspace for coordinated primary care, patient records, and childhood immunization.</p><div className="login-illustration"><div className="illustration-circle"><HeartPulse size={76}/></div><span className="float-tag tag-one"><Activity size={15}/> Community care</span><span className="float-tag tag-two"><ShieldCheck size={15}/> Private & secure</span></div></div><div className="login-side-footer">A healthier community starts here <span>✦</span></div></div><div className="login-form-area"><form className="login-form" onSubmit={submit}><div className="eyebrow"><span/> STAFF ACCESS</div><h2>Welcome back</h2><p>Sign in to access your health center workspace.</p><label>Email address<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@bhc.gov.ph" autoComplete="username" required/></label><label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" autoComplete="current-password" required/></label>{error && <div className="error-box">{error}</div>}<button className="primary-button full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in securely'}<ChevronDown size={17} className="arrow-up"/></button><div className="form-privacy"><ShieldCheck size={17}/>Your session is protected and access is role-based.</div></form><div className="login-copyright">© 2026 HIM Health Information System</div></div></div>;
}

function PageHeading({ eyebrow, title, description, action }) { return <div className="page-heading"><div><div className="eyebrow"><span/>{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>; }
function Overview({ user, queueCount, online, setPage }) {
  const [patients, setPatients] = useState([]), [encounters, setEncounters] = useState([]), [immunizations, setImmunizations] = useState([]);
  const [counts, setCounts] = useState(null);
  useEffect(() => { Promise.all([readCachedList('/patients', 'patients', {per_page:5}), readCachedList('/encounters', 'encounters'), readCachedList('/immunizations', 'immunizations')]).then(([p,e,i]) => { setPatients(p.slice(0,5)); setEncounters(e); setImmunizations(i); }); api.get('/summary').then(({data})=>setCounts(data)).catch(()=>{}); }, []);
  return <><PageHeading eyebrow="CLINIC SNAPSHOT" title={`Good day, ${user.name.split(' ')[0]}`} description="Here’s your health center activity at a glance." action={<div className="date-chip"><span className="date-dot"/>{new Date().toLocaleDateString('en-PH', { weekday: 'long', month: 'short', day: 'numeric' })}</div>}/><div className="metric-grid"><Metric icon={Users} label="Registered patients" value={counts?.patients ?? patients.length} foot="Patient directory" tone="mint"/><Metric icon={HeartPulse} label="Clinical encounters" value={counts?.encounters ?? encounters.length} foot="Across all patients" tone="blue"/><Metric icon={Syringe} label="Immunization records" value={counts?.immunizations ?? immunizations.length} foot="Doses recorded" tone="amber"/><Metric icon={online ? Wifi : WifiOff} label="Sync queue" value={queueCount} foot={online ? 'Ready to synchronize' : 'Waiting for connection'} tone={queueCount ? 'rose' : 'mint'}/></div><div className="overview-grid"><section className="panel recent-panel"><div className="panel-heading"><div><h3>Recently registered</h3><p>Latest additions to your patient directory</p></div><button className="text-button" onClick={() => setPage('patients')}>View directory <span>→</span></button></div>{patients.length ? patients.slice(0,5).map((patient) => <div className="patient-row" key={patient.id}><div className="patient-avatar">{patient.first_name?.slice(0,1)}{patient.last_name?.slice(0,1)}</div><div className="patient-name"><b>{fullName(patient)}</b><span>{patient.patient_number}</span></div><span className="row-meta">{patient.household?.barangay || 'Household not linked'}</span></div>) : <EmptyState icon={Users} title="Your patient directory is ready" text="Register a patient to get started with care records." action={() => setPage('patients')} actionText="Open directory"/>}</section><section className="panel quick-panel"><div className="panel-heading"><div><h3>Quick actions</h3><p>Common tasks for your clinic</p></div></div><button className="quick-action" onClick={() => setPage('patients')}><span className="quick-icon mint"><Plus size={19}/></span><span><b>Register a patient</b><small>Add a new patient record</small></span><span className="quick-arrow">→</span></button><button className="quick-action" onClick={() => setPage('encounters')}><span className="quick-icon blue"><FilePlus2 size={18}/></span><span><b>New encounter</b><small>Document a patient visit</small></span><span className="quick-arrow">→</span></button><button className="quick-action" onClick={() => setPage('immunizations')}><span className="quick-icon amber"><Baby size={18}/></span><span><b>Record immunization</b><small>Update a child’s vaccine record</small></span><span className="quick-arrow">→</span></button></section></div><div className="welcome-note"><div className="note-icon"><ShieldCheck size={19}/></div><div><b>Patient privacy is everyone’s responsibility</b><p>Only access records needed for your role. Keep your session secure when stepping away.</p></div><span className="note-sparkle">✦</span></div></>;
}
function Metric({ icon: Icon, label, value, foot, tone }) { return <div className="metric-card"><div className={`metric-icon ${tone}`}><Icon size={19}/></div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-foot">{foot}</div></div>; }
function EmptyState({ icon: Icon, title, text, action, actionText }) { return <div className="empty-state"><div className="empty-icon"><Icon size={22}/></div><b>{title}</b><span>{text}</span>{action && <button className="text-button" onClick={action}>{actionText} →</button>}</div>; }

function Patients({ online, notify, queueTransaction }) {
  const [rows, setRows] = useState([]), [households, setHouseholds] = useState([]), [search, setSearch] = useState(''), [showForm, setShowForm] = useState(false), [form, setForm] = useState(emptyPatient), [busy, setBusy] = useState(false), [archive, setArchive] = useState(null), [showHousehold, setShowHousehold] = useState(false), [householdForm, setHouseholdForm] = useState({household_code:'',barangay:'',purok_sitio:'',street:'',house_number:'',contact_number:''});
  const load = async () => { const list = await readCachedList('/patients', 'patients', { search, per_page: 100 }); const query = search.toLowerCase(); setRows(list.filter((patient) => !query || `${fullName(patient)} ${patient.patient_number} ${patient.philhealth_id || ''}`.toLowerCase().includes(query))); };
  useEffect(() => { load(); readCachedList('/households', 'households').then(setHouseholds); }, [search]);
  const submit = async (e) => { e.preventDefault(); setBusy(true); const payload = { ...form, household_id: form.household_id || null, patient_uuid: uuid() }; try { if (online) { await api.post('/patients', payload); notify('Patient registered successfully.'); } else await queueTransaction('patient', payload); setForm(emptyPatient); setShowForm(false); load(); } catch (error) { notify(error.response?.data?.message || 'Could not save this patient.'); } finally { setBusy(false); } };
  const deletePatient = async () => { if (!archive) return; try { if (online) { await api.delete(`/patients/${archive.id}`); notify('Patient record archived.'); } else notify('Archiving requires an active connection.'); setArchive(null); load(); } catch { notify('Unable to archive this record.'); } };
  const saveHousehold = async (e) => { e.preventDefault(); try { const {data}=await api.post('/households',householdForm); setHouseholds((list)=>[...list,data]); setShowHousehold(false); setHouseholdForm({household_code:'',barangay:'',purok_sitio:'',street:'',house_number:'',contact_number:''}); notify('Household registered.'); } catch(error) { notify(error.response?.data?.message || 'Unable to save household.'); } };
  return <><PageHeading eyebrow="PATIENT DIRECTORY" title="Patients" description="Search, register, and manage patient records." action={<div className="heading-actions"><button className="secondary-button" onClick={() => setShowHousehold(true)}><Home size={16}/> Add household</button><button className="primary-button" onClick={() => setShowForm(true)}><Plus size={17}/> Register patient</button></div>}/><section className="panel directory-panel"><div className="directory-insights"><div className="directory-insight"><span>Loaded records</span><b>{rows.length}</b></div><div className="directory-insight"><span>Linked to household</span><b>{rows.filter((patient) => patient.household_id || patient.household?.id).length}</b></div><div className="directory-insight"><span>No PhilHealth ID</span><b>{rows.filter((patient) => !patient.philhealth_id).length}</b></div></div><div className="directory-toolbar"><div className="search-box"><Search size={18}/><input aria-label="Search patients" placeholder="Search name, patient #, or PhilHealth ID…" value={search} onChange={(e) => setSearch(e.target.value)}/>{search && <button onClick={() => setSearch('')}><X size={15}/></button>}</div><span className="result-count">{rows.length} records</span></div>{rows.length ? <div className="table-wrap"><table><thead><tr><th>PATIENT</th><th>PATIENT NUMBER</th><th>DATE OF BIRTH</th><th>HOUSEHOLD</th><th>PHILHEALTH ID</th><th/></tr></thead><tbody>{rows.map((p) => <tr key={p.id}><td><div className="table-person"><div className="patient-avatar">{p.first_name?.[0]}{p.last_name?.[0]}</div><span><b>{fullName(p)}</b><small>{p.sex_at_birth}</small></span></div></td><td className="mono">{p.patient_number}</td><td>{p.date_of_birth?.slice(0,10)}</td><td>{p.household?.household_code || '—'}</td><td>{p.philhealth_id || '—'}</td><td><button className="icon-button danger-hover" title="Archive patient" onClick={() => setArchive(p)}><X size={16}/></button></td></tr>)}</tbody></table></div> : <EmptyState icon={Users} title={search ? 'No matching patients' : 'No patient records yet'} text={search ? 'Try another name, patient number, or ID.' : 'Register a patient to begin building your directory.'} action={!search ? () => setShowForm(true) : null} actionText="Register patient"/>}</section>
    {showForm && <Modal title="Register a patient" subtitle="Patient information is confidential and should be entered accurately." close={() => setShowForm(false)}><form className="form-grid" onSubmit={submit}><div className="form-section-title">Personal information</div><Field label="First name" required><input value={form.first_name} onChange={(e) => setForm({...form, first_name:e.target.value})} required maxLength="100"/></Field><Field label="Middle name"><input value={form.middle_name} onChange={(e) => setForm({...form, middle_name:e.target.value})}/></Field><Field label="Last name" required><input value={form.last_name} onChange={(e) => setForm({...form, last_name:e.target.value})} required/></Field><Field label="Suffix"><input value={form.suffix} onChange={(e) => setForm({...form, suffix:e.target.value})} placeholder="Jr., III"/></Field><Field label="Date of birth" required><input type="date" max={today} value={form.date_of_birth} onChange={(e) => setForm({...form, date_of_birth:e.target.value})} required/></Field><Field label="Sex at birth" required><select value={form.sex_at_birth} onChange={(e) => setForm({...form, sex_at_birth:e.target.value})}><option value="unknown">Prefer not to specify</option><option value="female">Female</option><option value="male">Male</option><option value="intersex">Intersex</option></select></Field><Field label="Patient number" required><input value={form.patient_number} onChange={(e) => setForm({...form, patient_number:e.target.value})} required maxLength="40" placeholder="BHC-2026-0001"/></Field><Field label="PhilHealth ID"><input value={form.philhealth_id} onChange={(e) => setForm({...form, philhealth_id:e.target.value})}/></Field><Field label="Contact number"><input value={form.contact_number} onChange={(e) => setForm({...form, contact_number:e.target.value})}/></Field><Field label="Email"><input type="email" value={form.email} onChange={(e) => setForm({...form, email:e.target.value})}/></Field><div className="form-section-title">Household & guardian</div><Field label="Link household"><select value={form.household_id} onChange={(e) => setForm({...form, household_id:e.target.value})}><option value="">No household linked</option>{households.map((h) => <option key={h.id} value={h.id}>{h.household_code} · {h.barangay}</option>)}</select></Field><Field label="Guardian name"><input value={form.guardian_name} onChange={(e) => setForm({...form, guardian_name:e.target.value})}/></Field><Field label="Relationship"><input value={form.guardian_relationship} onChange={(e) => setForm({...form, guardian_relationship:e.target.value})}/></Field><Field label="Guardian contact"><input value={form.guardian_contact_number} onChange={(e) => setForm({...form, guardian_contact_number:e.target.value})}/></Field><label className="check-field"><input type="checkbox" checked={form.is_household_head} onChange={(e) => setForm({...form, is_household_head:e.target.checked})}/> Household head</label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowForm(false)}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save patient'}</button></div></form></Modal>}
    {archive && <Modal title="Archive patient record?" subtitle={`Archive ${fullName(archive)}? Their clinical history remains retained according to records policy.`} close={() => setArchive(null)}><div className="modal-actions"><button className="secondary-button" onClick={() => setArchive(null)}>Keep record</button><button className="danger-button" onClick={deletePatient}>Archive patient</button></div></Modal>}
    {showHousehold && <Modal title="Add a household" subtitle="Create a household record to link patients living at the same address." close={() => setShowHousehold(false)}><form className="form-grid" onSubmit={saveHousehold}><Field label="Household code" required><input required maxLength="40" placeholder="HH-0001" value={householdForm.household_code} onChange={(e)=>setHouseholdForm({...householdForm,household_code:e.target.value})}/></Field><Field label="Barangay" required><input required maxLength="100" value={householdForm.barangay} onChange={(e)=>setHouseholdForm({...householdForm,barangay:e.target.value})}/></Field><Field label="Purok / sitio"><input value={householdForm.purok_sitio} onChange={(e)=>setHouseholdForm({...householdForm,purok_sitio:e.target.value})}/></Field><Field label="Street"><input value={householdForm.street} onChange={(e)=>setHouseholdForm({...householdForm,street:e.target.value})}/></Field><Field label="House number"><input value={householdForm.house_number} onChange={(e)=>setHouseholdForm({...householdForm,house_number:e.target.value})}/></Field><Field label="Contact number"><input value={householdForm.contact_number} onChange={(e)=>setHouseholdForm({...householdForm,contact_number:e.target.value})}/></Field><div className="modal-actions"><button type="button" className="secondary-button" onClick={()=>setShowHousehold(false)}>Cancel</button><button className="primary-button">Save household</button></div></form></Modal>}
  </>;
}

function Encounters({ online, notify, queueTransaction }) {
  const [patients, setPatients] = useState([]), [codes, setCodes] = useState([]), [encounters, setEncounters] = useState([]), [show, setShow] = useState(false), [search, setSearch] = useState(''), [selectedCodes, setSelectedCodes] = useState([]), [form, setForm] = useState({ patient_id:'', encountered_at:new Date().toISOString().slice(0,16), encounter_type:'consultation', chief_complaint:'', clinical_notes:'', temperature_celsius:'', systolic_bp:'', diastolic_bp:'', pulse_rate:'', respiratory_rate:'', oxygen_saturation:'', weight_kg:'', height_cm:'', follow_up_at:'' });
  const load = async () => setEncounters(await readCachedList('/encounters', 'encounters'));
  useEffect(() => { readCachedList('/patients', 'patients', {per_page:100}).then(setPatients); readCachedList('/icd10', 'codes').then(setCodes); load(); }, []);
  const filtered = codes.filter((c) => `${c.code} ${c.description}`.toLowerCase().includes(search.toLowerCase()));
  const toggleCode = (code) => setSelectedCodes((list) => list.some((item) => item.icd10_code_id === code.id) ? list.filter((item) => item.icd10_code_id !== code.id) : [...list, {icd10_code_id:code.id, is_primary:list.length === 0}]);
  const submit = async (e) => { e.preventDefault(); const payload = {...form, client_encounter_id:uuid(), patient_id:Number(form.patient_id), diagnoses:selectedCodes}; try { if (online) await api.post('/encounters', payload); else await queueTransaction('encounter', payload); notify(online ? 'Encounter recorded.' : 'Encounter queued for sync.'); setShow(false); setSelectedCodes([]); load(); } catch (error) { notify(error.response?.data?.message || 'Unable to save encounter.'); } };
  return <><PageHeading eyebrow="CLINICAL CARE" title="Encounters" description="Document a visit with observations, notes, and diagnoses." action={<button className="primary-button" onClick={() => setShow(true)}><Plus size={17}/> New encounter</button>}/><section className="panel directory-panel"><div className="panel-heading"><div><h3>Encounter history</h3><p>Recent patient visits and diagnoses</p></div></div>{encounters.length ? <div className="table-wrap"><table><thead><tr><th>DATE</th><th>PATIENT</th><th>CHIEF COMPLAINT</th><th>DIAGNOSES</th></tr></thead><tbody>{encounters.map((item)=><tr key={item.id}><td>{item.encountered_at?.slice(0,10)}</td><td><b>{item.patient?.first_name} {item.patient?.last_name}</b><small className="block-muted">{item.patient?.patient_number}</small></td><td>{item.chief_complaint || '—'}</td><td>{item.diagnoses?.map((d)=>d.code?.code).join(', ') || '—'}</td></tr>)}</tbody></table></div> : <EmptyState icon={HeartPulse} title="No encounters recorded" text="Start a clinical encounter to document care." action={()=>setShow(true)} actionText="New encounter"/>}</section>
  {show && <Modal title="New clinical encounter" subtitle="Record objective measurements and clinical findings." close={()=>setShow(false)} wide><form className="form-grid" onSubmit={submit}><Field label="Patient" required span><select required value={form.patient_id} onChange={(e)=>setForm({...form,patient_id:e.target.value})}><option value="">Select patient…</option>{patients.map((p)=><option key={p.id} value={p.id}>{fullName(p)} · {p.patient_number}</option>)}</select></Field><Field label="Encounter date & time" required><input type="datetime-local" value={form.encountered_at} onChange={(e)=>setForm({...form,encountered_at:e.target.value})} required/></Field><Field label="Visit type"><select value={form.encounter_type} onChange={(e)=>setForm({...form,encounter_type:e.target.value})}><option>consultation</option><option>follow_up</option><option>wellness</option><option>emergency</option></select></Field><div className="form-section-title">Vital signs</div>{[['temperature_celsius','Body temp (°C)','number'],['systolic_bp','Systolic BP (mmHg)','number'],['diastolic_bp','Diastolic BP (mmHg)','number'],['pulse_rate','Pulse rate (bpm)','number'],['respiratory_rate','Resp. rate (cpm)','number'],['oxygen_saturation','O₂ saturation (%)','number'],['weight_kg','Weight (kg)','number'],['height_cm','Height (cm)','number']].map(([key,label])=><Field key={key} label={label}><input type={key==='temperature_celsius'||key==='oxygen_saturation'||key==='weight_kg'||key==='height_cm'?'number':'number'} step="0.1" min="0" value={form[key]} onChange={(e)=>setForm({...form,[key]:e.target.value})}/></Field>)}<Field label="Chief complaint" span><textarea rows="2" maxLength="500" value={form.chief_complaint} onChange={(e)=>setForm({...form,chief_complaint:e.target.value})}/></Field><Field label="Clinical notes" span><textarea rows="3" value={form.clinical_notes} onChange={(e)=>setForm({...form,clinical_notes:e.target.value})}/></Field><Field label="Follow-up date"><input type="datetime-local" value={form.follow_up_at} onChange={(e)=>setForm({...form,follow_up_at:e.target.value})}/></Field><div className="form-section-title">ICD-10 diagnosis</div><div className="diagnosis-picker"><div className="search-box"><Search size={16}/><input placeholder="Search code or diagnosis…" value={search} onChange={(e)=>setSearch(e.target.value)}/></div><div className="diagnosis-options">{filtered.map((code)=><button type="button" key={code.id} className={`diagnosis-option ${selectedCodes.some((d)=>d.icd10_code_id===code.id)?'chosen':''}`} onClick={()=>toggleCode(code)}><span><b>{code.code}</b><small>{code.description}</small></span>{selectedCodes.some((d)=>d.icd10_code_id===code.id)&&<Check size={16}/>}</button>)}</div>{selectedCodes.map((item)=><label className="primary-diagnosis" key={item.icd10_code_id}><input type="radio" checked={item.is_primary} onChange={()=>setSelectedCodes((items)=>items.map((d)=>({...d,is_primary:d.icd10_code_id===item.icd10_code_id})))}/> Set selected diagnosis as primary</label>)}</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={()=>setShow(false)}>Cancel</button><button className="primary-button">Save encounter</button></div></form></Modal>}</>;
}

function Immunizations({ online, notify, queueTransaction }) {
  const [patients, setPatients] = useState([]), [schedules, setSchedules] = useState([]), [records, setRecords] = useState([]), [patientId, setPatientId] = useState(''), [dose, setDose] = useState(null), [form, setForm] = useState({administered_at:new Date().toISOString().slice(0,16),lot_number:'',administration_site:'',notes:''}), [sms, setSms] = useState('');
  const load = async () => { const list=await readCachedList('/immunizations', 'immunizations', patientId?{patient_id:patientId}:{}); setRecords(list.filter((record)=>!patientId||String(record.patient_id)===String(patientId))); };
  useEffect(()=>{readCachedList('/patients','patients',{per_page:100}).then(setPatients);readCachedList('/vaccine-schedules','schedules').then(setSchedules);},[]);
  useEffect(()=>{load();},[patientId]);
  const patient = patients.find((p)=>String(p.id)===String(patientId));
  const status = (schedule) => { if(records.some((r)=>r.vaccine_schedule_id===schedule.id)) return 'Completed'; const days=(Date.now()-new Date(patient?.date_of_birth||Date.now()).getTime())/86400000; const due=schedule.recommended_age_days; if(days<due-14)return 'Upcoming'; if(days<=due+14)return 'Due Today'; return 'Overdue'; };
  const submit = async (e) => {e.preventDefault(); const payload={...form, patient_id:Number(patientId),vaccine_schedule_id:dose.id,client_record_id:uuid()}; try{if(online)await api.post('/immunizations',payload);else await queueTransaction('immunization',payload);notify(online?'Vaccine dose recorded.':'Dose queued for sync.');setDose(null);load();}catch(error){notify(error.response?.data?.message||'Unable to save vaccine record.');}};
  const reminder = (schedule) => `Hello ${patient?.guardian_name||'Parent/Guardian'}, ${patient?.first_name||'your child'} is due for ${schedule.vaccine_name} ${schedule.dose_label||`Dose ${schedule.dose_number}`} at the Barangay Health Center. Please bring the child health record. Reply to this message if you need to reschedule.`;
  return <><PageHeading eyebrow="CHILD HEALTH" title="Immunizations" description="Track childhood doses and help families stay on schedule."/><section className="panel immunization-filter"><Field label="Select patient"><select value={patientId} onChange={(e)=>setPatientId(e.target.value)}><option value="">Choose a patient…</option>{patients.map((p)=><option key={p.id} value={p.id}>{fullName(p)} · {p.patient_number}</option>)}</select></Field><div className="immunization-help"><Syringe size={18}/><span>Schedule status is an administrative reminder, not clinical advice. Confirm current DOH guidance.</span></div></section>{patientId ? <><div className="schedule-heading"><div><h3>{fullName(patient)}</h3><p>{patient?.date_of_birth?.slice(0,10)} <span>·</span> {records.length} dose{records.length!==1?'s':''} recorded</p></div><button className="secondary-button" onClick={()=>setSms(reminder(schedules.find((s)=>status(s)!=='Completed')||schedules[0]||{}))}>Build SMS reminder</button></div><div className="schedule-grid">{schedules.map((schedule)=><div className="schedule-card" key={schedule.id}><div className="schedule-card-top"><span className="vaccine-icon"><Syringe size={17}/></span><span className={`vaccine-status ${status(schedule).toLowerCase().replace(' ','-')}`}>{status(schedule)}</span></div><h4>{schedule.vaccine_name}</h4><p>{schedule.vaccine_code} · {schedule.dose_label||`Dose ${schedule.dose_number}`}</p><div className="schedule-due">Recommended at <b>{schedule.recommended_age_months} months</b></div>{status(schedule)!=='Completed'&&<button className="small-primary" onClick={()=>setDose(schedule)}><Plus size={14}/> Record dose</button>}</div>)}</div><section className="panel dose-history"><div className="panel-heading"><div><h3>Dose history</h3><p>Recorded immunization events for this patient</p></div></div>{records.length?<div className="table-wrap"><table><thead><tr><th>VACCINE</th><th>ADMINISTERED</th><th>DOSE</th><th>LOT NUMBER</th><th>SITE</th></tr></thead><tbody>{records.map((r)=><tr key={r.id}><td><b>{r.schedule?.vaccine_name}</b><small className="block-muted">{r.schedule?.vaccine_code}</small></td><td>{r.administered_at?.slice(0,10)}</td><td>{r.dose_label||r.schedule?.dose_label}</td><td>{r.lot_number||'—'}</td><td>{r.administration_site||'—'}</td></tr>)}</tbody></table></div>:<EmptyState icon={Syringe} title="No doses recorded" text="Administered vaccines will appear here."/>}</section></>:<section className="panel select-patient"><div className="empty-icon"><Baby size={24}/></div><h3>Choose a patient to view their schedule</h3><p>The schedule shows administered doses and recommended age windows.</p></section>}
  {dose&&<Modal title="Record vaccine dose" subtitle={`${dose.vaccine_name} · ${dose.dose_label||`Dose ${dose.dose_number}`}`} close={()=>setDose(null)}><form className="form-grid" onSubmit={submit}><Field label="Administered date & time" required span><input type="datetime-local" required value={form.administered_at} onChange={(e)=>setForm({...form,administered_at:e.target.value})}/></Field><Field label="Lot number"><input value={form.lot_number} onChange={(e)=>setForm({...form,lot_number:e.target.value})}/></Field><Field label="Administration site"><input value={form.administration_site} onChange={(e)=>setForm({...form,administration_site:e.target.value})} placeholder="Left upper arm"/></Field><Field label="Notes" span><textarea rows="3" value={form.notes} onChange={(e)=>setForm({...form,notes:e.target.value})}/></Field><div className="modal-actions"><button type="button" className="secondary-button" onClick={()=>setDose(null)}>Cancel</button><button className="primary-button">Save dose</button></div></form></Modal>}
  {sms&&<Modal title="SMS reminder preview" subtitle="Review the message before copying it into your SMS provider." close={()=>setSms('')}><textarea className="sms-preview" rows="6" value={sms} onChange={(e)=>setSms(e.target.value)}/><div className="sms-footnote">This app does not send SMS. Confirm consent and recipient details before sending.</div><div className="modal-actions"><button className="secondary-button" onClick={()=>setSms('')}>Close</button><button className="primary-button" onClick={()=>navigator.clipboard?.writeText(sms).then(()=>notify('Reminder copied to clipboard.'))}>Copy message</button></div></Modal>}
  </>;
}

function SyncDashboard({ online, count, refresh }) {const [items,setItems]=useState([]);useEffect(()=>{db.queue.orderBy('id').toArray().then(setItems);},[count]);return <><PageHeading eyebrow="DEVICE & CONNECTIVITY" title="Offline sync" description="Review locally queued work and synchronize it securely when connected." action={<button className="primary-button" onClick={refresh} disabled={!online}><RefreshCw size={17}/> Sync now</button>}/><div className={`connection-banner ${online?'connected':'disconnected'}`}><div className="connection-icon">{online?<Wifi size={20}/>:<WifiOff size={20}/>}</div><div><b>{online?'You’re connected':'Working offline'}</b><p>{online?'Your device can securely send queued transactions to the health center.':'New records are saved on this device until a connection is available.'}</p></div><span className="connection-label">{online?'ONLINE':'OFFLINE'}</span></div><div className="sync-stats"><Metric icon={CloudOff} label="Awaiting sync" value={count} foot="On this device" tone={count?'amber':'mint'}/><Metric icon={Check} label="Sync mode" value="Automatic" foot="Safe retry with idempotency" tone="blue"/><Metric icon={ShieldCheck} label="Data handling" value="Protected" foot="Token-authenticated API" tone="mint"/></div><section className="panel queue-panel"><div className="panel-heading"><div><h3>Queued transactions</h3><p>Transactions sync in the order they were captured.</p></div><span className="result-count">{items.length} queued</span></div>{items.length?<div className="queue-list">{items.map((item)=><div className="queue-row" key={item.id}><div className="queue-entity"><div className="queue-type-icon"><FilePlus2 size={17}/></div><span><b>{item.entity_type.charAt(0).toUpperCase()+item.entity_type.slice(1)} record</b><small>{item.client_transaction_id}</small></span></div><span className="pending-badge"><span/>Pending</span><time>{new Date(item.created_at).toLocaleString()}</time></div>)}</div>:<EmptyState icon={Check} title="Everything is up to date" text="New offline work will appear here until it is synchronized."/>}</section><div className="sync-note"><ShieldCheck size={17}/><span>Each queued transaction carries a unique ID to prevent duplicate records if a sync is retried.</span></div></>}

function Reports() {const [from,setFrom]=useState(`${new Date().getFullYear()}-01-01`),[to,setTo]=useState(today),[data,setData]=useState([]),[loaded,setLoaded]=useState(false),[error,setError]=useState('');const load=async()=>{setError('');try{const {data}=await api.get('/reports/fhsis/diagnoses',{params:{from,to}});setData(data.diagnoses||[]);setLoaded(true);}catch(e){setError(e.response?.data?.message||'Could not load report data.');}};return <><PageHeading eyebrow="PUBLIC HEALTH REPORTING" title="FHSIS morbidity report" description="Diagnosis counts for the selected encounter period." action={<button className="secondary-button print-button" onClick={()=>window.print()}><Printer size={16}/> Print report</button>}/><section className="panel report-filters"><Field label="From"><input type="date" value={from} max={to} onChange={(e)=>setFrom(e.target.value)}/></Field><Field label="To"><input type="date" value={to} min={from} max={today} onChange={(e)=>setTo(e.target.value)}/></Field><button className="primary-button" onClick={load}><BarChart3 size={16}/> Generate report</button></section>{error&&<div className="error-box">{error}</div>}{loaded&&<><div className="report-summary"><div><span>REPORTING PERIOD</span><b>{from} — {to}</b></div><div><span>DIAGNOSIS CATEGORIES</span><b>{data.length}</b></div><div><span>TOTAL DIAGNOSIS EVENTS</span><b>{data.reduce((sum,row)=>sum+Number(row.total_count),0)}</b></div></div><section className="panel directory-panel"><div className="panel-heading"><div><h3>Diagnosis frequency</h3><p>Counted from recorded encounter diagnoses</p></div></div>{data.length?<div className="table-wrap"><table><thead><tr><th>ICD-10 CODE</th><th>DIAGNOSIS</th><th>TOTAL COUNT</th><th>PRIMARY COUNT</th><th>DISTRIBUTION</th></tr></thead><tbody>{data.map((row)=>{const max=Math.max(...data.map((d)=>Number(d.total_count)),1);return <tr key={row.code}><td className="mono"><b>{row.code}</b></td><td>{row.description}</td><td>{row.total_count}</td><td>{row.primary_count}</td><td><div className="bar-track"><span style={{width:`${Number(row.total_count)/max*100}%`}}/></div></td></tr>})}</tbody></table></div>:<EmptyState icon={BarChart3} title="No diagnoses in this period" text="Try a different reporting date range."/>}</section></>}</>}

function Staff() {const [staff,setStaff]=useState([]),[form,setForm]=useState({name:'',email:'',password:'',role:'health_worker'}),[error,setError]=useState('');const load=()=>api.get('/users').then(({data})=>setStaff(data)).catch(()=>{});useEffect(()=>{load();},[]);const submit=async(e)=>{e.preventDefault();setError('');try{await api.post('/users',form);setForm({name:'',email:'',password:'',role:'health_worker'});load();}catch(err){setError(err.response?.data?.message||'Could not create account.');}};return <><PageHeading eyebrow="ACCESS CONTROL" title="Staff accounts" description="Manage authorized health center users and their roles."/><div className="staff-grid"><section className="panel staff-form-panel"><div className="panel-heading"><div><h3>Add a staff account</h3><p>Use a unique email and a strong temporary password.</p></div></div><form onSubmit={submit} className="stacked-form"><Field label="Full name" required><input required value={form.name} onChange={(e)=>setForm({...form,name:e.target.value})}/></Field><Field label="Email address" required><input type="email" required value={form.email} onChange={(e)=>setForm({...form,email:e.target.value})}/></Field><Field label="Temporary password" required><input type="password" minLength="12" required value={form.password} onChange={(e)=>setForm({...form,password:e.target.value})}/></Field><Field label="Role"><select value={form.role} onChange={(e)=>setForm({...form,role:e.target.value})}><option value="health_worker">Health worker</option><option value="super_admin">Super admin</option></select></Field>{error&&<div className="error-box">{error}</div>}<button className="primary-button full"><Plus size={16}/> Create account</button></form></section><section className="panel staff-list-panel"><div className="panel-heading"><div><h3>Team members</h3><p>{staff.length} authorized accounts</p></div></div>{staff.map((member)=><div className="staff-row" key={member.id}><div className="patient-avatar">{member.name[0]}</div><div className="staff-row-name"><b>{member.name}</b><small>{member.email}</small></div><span className={`role-badge ${member.role}`}>{member.role==='super_admin'?'Admin':'Health worker'}</span></div>)}</section></div></>}

function Field({label,required,span,children}) {return <label className={`field ${span?'field-span':''}`}><span>{label}{required&&<i>*</i>}</span>{children}</label>}
function Modal({title,subtitle,close,children,wide}) {return <div className="modal-backdrop" onMouseDown={(e)=>{if(e.target===e.currentTarget)close();}}><section className={`modal ${wide?'modal-wide':''}`} role="dialog" aria-modal="true"><div className="modal-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={close}><X size={19}/></button></div>{children}</section></div>}

createRoot(document.getElementById('app')).render(<App/>);

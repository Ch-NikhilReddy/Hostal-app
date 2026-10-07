import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { loadTokens, setTokens } from './api/client';
import { getMe, type Role, type User } from './api/endpoints';
import { LoginPage } from './pages/login';
import { OwnerOverview } from './pages/owner-overview';
import { OwnerProperties } from './pages/owner-properties';
import { OwnerBookings } from './pages/owner-bookings';
import { AdminVerification } from './pages/admin-verification';
import { AdminCommission } from './pages/admin-commission';
import { AdminReports } from './pages/admin-reports';

/**
 * Shell and routing.
 *
 * One router for both dashboards, gated by role. Admin-only links are hidden from
 * owners rather than merely disabled, and the routes themselves also re-check the
 * role — hiding a link is presentation, not authorisation, and the server enforces
 * the real boundary.
 */
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const { access } = loadTokens();
    if (!access) {
      setChecking(false);
      return;
    }
    getMe()
      .then((res) => setUser(res.user))
      .catch(() => setTokens(null, null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return (
      <div className="loading">
        <div className="spinner" />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage onSignedIn={setUser} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const isAdmin = user.role === 'ADMIN';
  const signOut = () => {
    setTokens(null, null);
    setUser(null);
    navigate('/login');
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">HM</div>
          <div className="brand-text">
            <div className="brand-name">HostelMitra</div>
            <div className="brand-sub">{isAdmin ? 'Admin panel' : 'Owner dashboard'}</div>
          </div>
        </div>

        <div className="nav-group">
          <div className="nav-label">Owner</div>
          <NavLink to="/" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} end>
            🏠 <span>Overview</span>
          </NavLink>
          <NavLink to="/properties" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            🏢 <span>Properties</span>
          </NavLink>
          <NavLink to="/bookings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            📋 <span>Bookings</span>
          </NavLink>
        </div>

        {isAdmin ? (
          <div className="nav-group">
            <div className="nav-label">Admin</div>
            <NavLink to="/verification" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              ✅ <span>Verification</span>
            </NavLink>
            <NavLink to="/commission" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              💰 <span>Commission</span>
            </NavLink>
            <NavLink to="/reports" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              📊 <span>Reports</span>
            </NavLink>
          </div>
        ) : null}

        <div style={{ marginTop: 'auto', paddingTop: 20 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="brand-mark" style={{ width: 30, height: 30, fontSize: 12 }}>
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="small" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user.name}
              </div>
              <div className="small muted">{user.role}</div>
            </div>
          </div>
          <button className="nav-item" onClick={signOut}>
            🚪 <span>Sign out</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<OwnerOverview user={user} />} />
          <Route path="/properties" element={<OwnerProperties />} />
          <Route path="/bookings" element={<OwnerBookings />} />
          <Route
            path="/verification"
            element={isAdmin ? <AdminVerification /> : <Navigate to="/" replace />}
          />
          <Route path="/commission" element={isAdmin ? <AdminCommission /> : <Navigate to="/" replace />} />
          <Route path="/reports" element={isAdmin ? <AdminReports /> : <Navigate to="/" replace />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function RoleGuard({ user, allow }: { user: User | null; allow: Role[] }) {
  if (!user) return <Navigate to="/login" replace />;
  if (!allow.includes(user.role)) return <Navigate to="/" replace />;
  return null;
}
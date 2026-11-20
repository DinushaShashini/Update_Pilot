import React from 'react';
import { Link } from 'react-router-dom';

export const NotFoundPage: React.FC = () => {
  return (
    <div
      className="login-page-container"
      style={{ textAlign: 'center', flexDirection: 'column' }}
      data-testid="not-found-page"
    >
      <div className="login-card" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '48px', fontWeight: 800, color: '#38bdf8', marginBottom: '8px' }}>
          404
        </div>
        <h1 style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc', marginBottom: '8px' }}>
          Page Not Found
        </h1>
        <p style={{ fontSize: '14px', color: '#94a3b8', marginBottom: '24px' }}>
          The page you are looking for does not exist or has been moved.
        </p>
        <Link
          to="/"
          className="btn btn-primary"
          style={{ textDecoration: 'none', display: 'inline-flex' }}
        >
          Return to Overview
        </Link>
      </div>
    </div>
  );
};

export default NotFoundPage;

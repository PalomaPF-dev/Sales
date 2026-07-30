import { useEffect, useState } from 'react';
import { api } from '../api';
import type { User } from '../types';
import { ROLE_NAMES } from '../types';

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api<User[]>('/users').then(setUsers).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>値上げ交渉管理システム</h1>
        <p>ログインするユーザーを選択してください（プロトタイプ版）</p>
        {error && <div className="alert error">{error}</div>}
        <div className="user-pick">
          {users.map((u) => (
            <button key={u.id} onClick={() => onLogin(u)}>
              <span>
                <strong>{u.name}</strong>
                <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 12 }}>
                  {u.branch}
                  {u.office ? ` / ${u.office}` : ''}
                </span>
              </span>
              <span className="badge blue">{ROLE_NAMES[u.role]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

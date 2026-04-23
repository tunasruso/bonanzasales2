import { useState } from 'react';
import { Lock, User, ArrowRight } from 'lucide-react';
import { checkUser } from '../lib/supabase';
import '../index.css';

interface LoginProps {
    onLogin: () => void;
}

export default function Login({ onLogin }: LoginProps) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const result = await checkUser(username, password);

            if (result === 'ok') {
                onLogin();
            } else if (result === 'network_error') {
                setError('Ошибка подключения. Попробуйте позже.');
            } else {
                setError('Неверное имя пользователя или пароль');
            }
        } catch {
            setError('Ошибка подключения. Попробуйте позже.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-container">
            <div className="login-card">
                <div className="login-header">
                    <div className="login-icon">
                        <Lock size={32} color="#00d4ff" />
                    </div>
                    <h1>Бонанза продажи</h1>
                    <p>Вход в систему</p>
                </div>

                <form onSubmit={handleSubmit} className="login-form">
                    <div className="input-group">
                        <User size={18} className="input-icon" />
                        <input
                            type="text"
                            placeholder="Имя пользователя"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            disabled={loading}
                            autoComplete="username"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                        />
                    </div>

                    <div className="input-group">
                        <Lock size={18} className="input-icon" />
                        <input
                            type="password"
                            placeholder="Пароль"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            disabled={loading}
                            autoComplete="current-password"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                        />
                    </div>

                    {error && <div className="error-message">{error}</div>}

                    <button type="submit" className="login-btn" disabled={loading}>
                        {loading ? 'Вход...' : (
                            <>
                                Войти <ArrowRight size={18} style={{ marginLeft: 8 }} />
                            </>
                        )}
                    </button>
                </form>
            </div>
        </div>
    );
}

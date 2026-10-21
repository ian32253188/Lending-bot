import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import authRoutes from './auth';
import authMiddleware from '../middleware/auth';
import config from '../config';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/auth', authRoutes);
app.get('/api/protected', authMiddleware, (req: any, res) => {
    res.json({ message: 'ok', user: req.user });
});

describe('本地管理員認證與 JWT 驗證 (Local Auth Tests)', () => {
    it('使用錯誤的密碼登入應返回 401 Unauthorized', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ password: 'wrong-password-12345' });

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('密碼錯誤');
    });

    it('使用正確的 ADMIN_PASSWORD 登入應成功簽發 JWT Token', async () => {
        const correctPassword = config.admin.password;
        const res = await request(app)
            .post('/api/auth/login')
            .send({ password: correctPassword });

        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.user).toBeDefined();
        expect(res.body.user.role).toBe('admin');
    });

    it('使用剛簽發的 JWT 存取 /api/auth/verify 應返回 valid: true', async () => {
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ password: config.admin.password });

        const token = loginRes.body.token;

        const verifyRes = await request(app)
            .get('/api/auth/verify')
            .set('Authorization', `Bearer ${token}`);

        expect(verifyRes.status).toBe(200);
        expect(verifyRes.body.valid).toBe(true);
        expect(verifyRes.body.user.role).toBe('admin');
    });

    it('使用剛簽發的 JWT 存取受保護路由應成功通過中介層', async () => {
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ password: config.admin.password });

        const token = loginRes.body.token;

        const res = await request(app)
            .get('/api/protected')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('ok');
        expect(res.body.user.role).toBe('admin');
    });

    it('拒絕第二個本機 JWT 帳戶，避免多帳戶存取受保護資料', async () => {
        const token = jwt.sign({ id: '11111111-1111-4111-8111-111111111111', role: 'user' }, config.jwt.secret);

        const protectedRes = await request(app)
            .get('/api/protected')
            .set('Authorization', `Bearer ${token}`);
        expect(protectedRes.status).toBe(403);
        expect(protectedRes.body.error).toContain('單一管理帳戶');

        const verifyRes = await request(app)
            .get('/api/auth/verify')
            .set('Authorization', `Bearer ${token}`);
        expect(verifyRes.status).toBe(403);
        expect(verifyRes.body.valid).toBe(false);
    });

    it('JWT 快取不會讓受保護路由在 Token 到期後繼續放行', async () => {
        const expiresAt = Math.floor(Date.now() / 1000) + 10;
        const token = jwt.sign({
            id: '00000000-0000-0000-0000-000000000001',
            role: 'admin',
            exp: expiresAt,
            jti: `expiry-test-${Math.random()}`,
        }, config.jwt.secret);

        await request(app)
            .get('/api/protected')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(expiresAt * 1000 + 1);
        try {
            await request(app)
                .get('/api/protected')
                .set('Authorization', `Bearer ${token}`)
                .expect(401);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('連續錯誤登入達上限後回傳 429 與 Retry-After', async () => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            await request(app)
                .post('/api/auth/login')
                .set('X-Forwarded-For', '203.0.113.99')
                .send({ password: `wrong-password-${attempt}` })
                .expect(401);
        }

        const limited = await request(app)
            .post('/api/auth/login')
            .set('X-Forwarded-For', '203.0.113.99')
            .send({ password: 'wrong-password-final' })
            .expect(429);

        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
        await request(app)
            .post('/api/auth/login')
            .set('X-Forwarded-For', '203.0.113.99')
            .send({ password: 'wrong-password-after-lock' })
            .expect(429);

        await request(app)
            .post('/api/auth/login')
            .set('X-Forwarded-For', '203.0.113.100')
            .send({ password: config.admin.password })
            .expect(200);
    });
});

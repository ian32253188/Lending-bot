import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import config from '../config';
import authMiddleware from '../middleware/auth';
import researchRoutes from './research';
import { SINGLE_ACCOUNT_USER_ID } from '../config/single-account';

const app = express();
app.use('/api/research', authMiddleware, researchRoutes);

describe('protected USD research status endpoint', () => {
  it('rejects requests without administrator authentication', async () => {
    const response = await request(app).get('/api/research/status');
    expect(response.status).toBe(401);
  });

  it('returns research health for the single-account administrator', async () => {
    const token = jwt.sign({ id: SINGLE_ACCOUNT_USER_ID, role: 'admin' }, config.jwt.secret, { expiresIn: '1h' });
    const response = await request(app).get('/api/research/status').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toHaveProperty('databaseReady');
    expect(response.body.retentionDays).toBe(180);
  });
});

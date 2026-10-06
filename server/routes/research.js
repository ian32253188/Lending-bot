const express = require('express');
const { getShadowResearchStatus } = require('../services/research/shadow');

const router = express.Router();

router.get('/status', async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        res.json(await getShadowResearchStatus());
    } catch (error) {
        res.status(503).json({ error: '研究狀態暫時無法讀取' });
    }
});

module.exports = router;

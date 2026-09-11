require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5000';

// ═══════════════════════════════════════════════════════
// KONSTANTEN — 0% KOMMISSION
// ═══════════════════════════════════════════════════════
const COMMISSION_RATE = 0;       // 0% — wir nehmen nichts
const DRIVER_SHARE = 1.0;        // Fahrer bekommt 100% der Fracht
const FUEL_INFO_SHARE = 0.15;    // Nur Info (Schätzung Treibstoff)
const TOLLS_INFO_SHARE = 0.05;   // Nur Info (Schätzung Maut)

if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('❌ FATAL: JWT_SECRET missing');
    process.exit(1);
}
console.log('✅ Environment validated');
console.log('💰 Commission: ' + (COMMISSION_RATE * 100) + '% (FREE)');

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'cargothink',
});

pool.connect((err) => {
    if (err) { console.error('❌ DB failed:', err.message); process.exit(1); }
    console.log('✅ Database connected');
});

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '20mb' }));

app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true }));
app.use('/api/auth/register', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true }));

// ═══════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════
const registerSchema = Joi.object({
    email: Joi.string().email().required().max(255),
    password: Joi.string().min(6).required().max(255),
    full_name: Joi.string().min(2).required().max(100),
    company_name: Joi.string().allow('').max(100),
    phone: Joi.string().allow('').max(20),
    role: Joi.string().valid('shipper', 'carrier').default('shipper'),
});

const loginSchema = Joi.object({
    email: Joi.string().email().required().max(255),
    password: Joi.string().required().max(255),
});

const cargoSchema = Joi.object({
    origin_city: Joi.string().min(2).required().max(100),
    dest_city: Joi.string().min(2).required().max(100),
    origin_address: Joi.string().allow('', null).max(200),
    dest_address: Joi.string().allow('', null).max(200),
    weight_kg: Joi.number().integer().min(1).max(100000).required(),
    cargo_type: Joi.string().valid('refrigerated', 'open', 'van', 'isothermal', 'tank').required(),
    pickup_date: Joi.date().required(),
    delivery_date: Joi.date().allow(null),
    price: Joi.number().min(1).max(99999999).required(),
    base_price: Joi.number().min(1).allow(null),
    surge_multiplier: Joi.number().min(0.5).max(3.0).allow(null),
    price_factors: Joi.object().allow(null),
    description: Joi.string().allow('').max(500),
});

const transportSchema = Joi.object({
    current_city: Joi.string().min(2).required().max(100),
    capacity_kg: Joi.number().integer().min(1).max(100000).required(),
    vehicle_type: Joi.string().valid('refrigerated', 'open', 'van', 'isothermal', 'tank').required(),
    available_from: Joi.date().required(),
    price_per_km: Joi.number().min(0).max(9999).allow(null),
    description: Joi.string().allow('').max(500),
});

// ═══════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════
const auth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'No token provided' });
        const decoded = jwt.verify(token, JWT_SECRET);
        const result = await pool.query('SELECT id, email, full_name, role, rating, verified FROM users WHERE id = $1', [decoded.userId]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'User not found' });
        req.user = result.rows[0];
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
        return res.status(401).json({ error: 'Invalid token' });
    }
};

const requireRole = (roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
};

// ═══════════════════════════════════════════════════════
// HILFSFUNKTIONEN
// ═══════════════════════════════════════════════════════
async function getSetting(key, defaultValue) {
    try {
        const result = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
        return result.rows[0]?.value || defaultValue;
    } catch (e) { return defaultValue; }
}

async function setSetting(key, value) {
    await pool.query(`
        INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, String(value)]);
}

async function getDistance(origin, dest) {
    const r = await pool.query(
        `SELECT distance_km FROM city_distances 
         WHERE (city_a = $1 AND city_b = $2) OR (city_a = $2 AND city_b = $1)`,
        [origin, dest]
    );
    return r.rows[0]?.distance_km || 1500;
}

function calculateMatchScore(cargo, transport) {
    let score = 0;
    if (transport.capacity_kg >= cargo.weight_kg) score += 30;
    else if (transport.capacity_kg >= cargo.weight_kg * 0.8) score += 20;
    else if (transport.capacity_kg >= cargo.weight_kg * 0.6) score += 10;
    else return 0;

    if (transport.vehicle_type === cargo.cargo_type) score += 25;
    else if (transport.vehicle_type === 'van' && cargo.cargo_type === 'open') score += 10;

    if (transport.current_city === cargo.origin_city) score += 20;
    else if (transport.current_city === cargo.dest_city) score += 10;

    const diff = (new Date(transport.available_from) - new Date(cargo.pickup_date)) / (1000 * 60 * 60 * 24);
    if (diff <= 0 && diff >= -3) score += 15;
    else if (diff <= 3 && diff > 0) score += 10;
    else if (diff <= 7 && diff > 3) score += 5;

    if (transport.price_per_km) {
        const estimatedCost = transport.price_per_km * 500;
        const ratio = cargo.price / estimatedCost;
        if (ratio >= 1.2) score += 10;
        else if (ratio >= 1.0) score += 5;
    }
    return Math.min(score, 100);
}

async function generateMatches(userId) {
    try {
        const cargoRes = await pool.query("SELECT * FROM cargo WHERE status = 'open'");
        const transportRes = await pool.query("SELECT * FROM transport WHERE status = 'available'");
        const allMatches = [];

        for (const cargo of cargoRes.rows) {
            for (const transport of transportRes.rows) {
                if (cargo.shipper_id === transport.carrier_id) continue;
                const score = calculateMatchScore(cargo, transport);
                if (score >= 50) {
                    allMatches.push({ cargo_id: cargo.id, transport_id: transport.id, match_score: score });
                }
            }
        }

        allMatches.sort((a, b) => b.match_score - a.match_score);
        const topMatches = allMatches.slice(0, 20);

        for (const m of topMatches) {
            await pool.query(
                `INSERT INTO matches (cargo_id, transport_id, match_score, status)
                 VALUES ($1, $2, $3, 'pending')
                 ON CONFLICT (cargo_id, transport_id) DO UPDATE SET match_score = $3, updated_at = NOW()`,
                [m.cargo_id, m.transport_id, m.match_score]
            );
        }
        return topMatches;
    } catch (err) { console.error('Match generation error:', err); throw err; }
}

// ═══════════════════════════════════════════════════════
// BREAKDOWN — 0% Kommission
// ═══════════════════════════════════════════════════════
function calculateBreakdown(total_price) {
    const total = parseFloat(total_price);
    const fuel_estimate = Math.round(total * FUEL_INFO_SHARE);
    const tolls_estimate = Math.round(total * TOLLS_INFO_SHARE);
    const net_profit = total - fuel_estimate - tolls_estimate;
    
    return {
        total_price: total,
        driver_pay: total,              // Fahrer bekommt 100%
        platform_fee: 0,                // Wir nehmen nichts
        commission_rate: 0,
        fuel_estimate: fuel_estimate,   // Info
        tolls_estimate: tolls_estimate, // Info
        net_profit: net_profit          // Info (was der Fahrer nach Sprit/Maut behält)
    };
}

// ═══════════════════════════════════════════════════════
// DYNAMIC PRICING
// ═══════════════════════════════════════════════════════
async function calculateDynamicPrice(origin_city, dest_city, weight_kg, cargo_type, pickup_date) {
    const dieselCurrent = parseFloat(await getSetting('diesel_price', '68'));
    const dieselReference = parseFloat(await getSetting('diesel_reference', '60'));
    const surgeEnabled = (await getSetting('surge_enabled', 'true')) === 'true';

    const distance_km = await getDistance(origin_city, dest_city);
    const pricePerKmMap = { 'refrigerated': 55, 'van': 45, 'open': 40, 'isothermal': 50, 'tank': 60 };
    const pricePerKm = pricePerKmMap[cargo_type] || 45;
    const weightMultiplier = 1 + (weight_kg / 20) * 0.3;
    const basePrice = distance_km * pricePerKm * weightMultiplier;

    const openCargoRes = await pool.query("SELECT COUNT(*) FROM cargo WHERE status = 'open'");
    const availableTransportRes = await pool.query("SELECT COUNT(*) FROM transport WHERE status = 'available'");
    const openCargos = parseInt(openCargoRes.rows[0].count) || 0;
    const availableTrucks = parseInt(availableTransportRes.rows[0].count) || 1;

    let demandFactor = 1.0;
    if (surgeEnabled) {
        const ratio = openCargos / Math.max(availableTrucks, 1);
        if (ratio < 0.5) demandFactor = 0.85;
        else if (ratio < 1.0) demandFactor = 0.95;
        else if (ratio < 1.5) demandFactor = 1.0;
        else if (ratio < 2.5) demandFactor = 1.25;
        else if (ratio < 4.0) demandFactor = 1.55;
        else demandFactor = 1.9;
    }

    let fuelFactor = 1.0;
    if (surgeEnabled) {
        fuelFactor = Math.max(0.9, Math.min(1.8, dieselCurrent / dieselReference));
    }

    const now = new Date();
    const hour = now.getHours();
    let timeFactor = 1.0;
    if (surgeEnabled) {
        if ((hour >= 7 && hour < 10) || (hour >= 17 && hour < 20)) timeFactor = 1.15;
        else if (hour >= 22 || hour < 6) timeFactor = 1.25;
    }

    const month = now.getMonth() + 1;
    let seasonFactor = 1.0;
    if (surgeEnabled) {
        if (month === 12 || month === 1 || month === 2) seasonFactor = 1.20;
        else if (month >= 8 && month <= 10) seasonFactor = 1.15;
        else if (month >= 4 && month <= 5) seasonFactor = 1.05;
    }

    let urgencyFactor = 1.0;
    if (surgeEnabled && pickup_date) {
        const daysUntil = (new Date(pickup_date) - now) / (1000 * 60 * 60 * 24);
        if (daysUntil < 1) urgencyFactor = 1.30;
        else if (daysUntil < 2) urgencyFactor = 1.15;
        else if (daysUntil > 7) urgencyFactor = 0.95;
    }

    const routeRes = await pool.query(`
        SELECT COUNT(*) FROM cargo 
        WHERE origin_city = $1 AND dest_city = $2 
        AND created_at > NOW() - INTERVAL '30 days'
    `, [origin_city, dest_city]);
    const routeCount = parseInt(routeRes.rows[0].count) || 0;
    let popularityFactor = 1.0;
    if (surgeEnabled) {
        if (routeCount > 50) popularityFactor = 0.90;
        else if (routeCount > 20) popularityFactor = 0.95;
        else if (routeCount < 3) popularityFactor = 1.10;
    }

    const totalFactor = demandFactor * fuelFactor * timeFactor * seasonFactor * urgencyFactor * popularityFactor;
    const total = Math.round(basePrice * totalFactor);

    const fuel_estimate = Math.round(total * FUEL_INFO_SHARE);
    const tolls_estimate = Math.round(total * TOLLS_INFO_SHARE);

    return {
        base_price: Math.round(basePrice),
        distance_km,
        price_per_km: pricePerKm,
        weight_multiplier: parseFloat(weightMultiplier.toFixed(2)),
        demand_factor: parseFloat(demandFactor.toFixed(2)),
        fuel_factor: parseFloat(fuelFactor.toFixed(2)),
        time_factor: parseFloat(timeFactor.toFixed(2)),
        season_factor: parseFloat(seasonFactor.toFixed(2)),
        urgency_factor: parseFloat(urgencyFactor.toFixed(2)),
        popularity_factor: parseFloat(popularityFactor.toFixed(2)),
        total_factor: parseFloat(totalFactor.toFixed(2)),
        total_price: total,
        driver_pay: total,
        platform_fee: 0,
        commission_rate: 0,
        fuel_estimate: fuel_estimate,
        tolls_estimate: tolls_estimate,
        net_profit: total - fuel_estimate - tolls_estimate,
        surge_active: totalFactor > 1.15,
        surge_label: totalFactor > 1.5 ? '🔥 Высокий спрос' : totalFactor > 1.15 ? '📈 Повышенный спрос' : totalFactor < 0.9 ? '📉 Скидка' : null,
        diesel_current: dieselCurrent,
        diesel_reference: dieselReference,
        open_cargos: openCargos,
        available_trucks: availableTrucks
    };
}

// ═══════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/auth/register', async (req, res) => {
    try {
        const { error } = registerSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });
        const { email, password, full_name, company_name, phone, role } = req.body;

        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'Email already registered' });

        const hash = await bcrypt.hash(password, 12);
        const id = uuidv4();
        await pool.query(
            `INSERT INTO users (id, email, password_hash, full_name, company_name, phone, role)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, email, hash, full_name, company_name || null, phone || null, role || 'shipper']
        );
        const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '7d' });
        res.status(201).json({ token, user: { id, email, full_name, role: role || 'shipper', rating: 0, verified: false } });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { error } = loginSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });
        const { email, password } = req.body;
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, company_name: user.company_name, rating: user.rating, verified: user.verified } });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/auth/me', auth, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, email, full_name, role, company_name, phone, rating, verified, total_ratings FROM users WHERE id = $1', [req.user.id]);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// CARGO
// ═══════════════════════════════════════════════════════
app.get('/api/cargo', auth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.*, u.full_name as shipper_name, u.rating as shipper_rating, u.verified as shipper_verified
            FROM cargo c JOIN users u ON c.shipper_id = u.id 
            WHERE c.status = 'open' ORDER BY c.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/cargo/my', auth, requireRole(['shipper']), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.*,
                (SELECT COUNT(*) FROM matches m WHERE m.cargo_id = c.id AND m.status = 'pending') as pending_matches,
                (SELECT COUNT(*) FROM matches m WHERE m.cargo_id = c.id AND m.status = 'accepted') as active_matches,
                (SELECT COUNT(*) FROM matches m WHERE m.cargo_id = c.id AND m.status IN ('in_transit', 'delivered_by_carrier')) as shipping_matches,
                (SELECT COUNT(*) FROM matches m WHERE m.cargo_id = c.id AND m.status = 'delivered') as completed_matches
            FROM cargo c
            WHERE c.shipper_id = $1
            ORDER BY c.created_at DESC
        `, [req.user.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/cargo', auth, requireRole(['shipper']), async (req, res) => {
    try {
        const { error } = cargoSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });
        const { origin_city, dest_city, origin_address, dest_address, weight_kg, cargo_type, pickup_date, delivery_date, price, base_price, surge_multiplier, price_factors, description } = req.body;
        const id = uuidv4();
        await pool.query(
            `INSERT INTO cargo (id, shipper_id, origin_city, dest_city, origin_address, dest_address, weight_kg, cargo_type, pickup_date, delivery_date, price, base_price, surge_multiplier, price_factors, description)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [id, req.user.id, origin_city, dest_city, origin_address || null, dest_address || null, weight_kg, cargo_type, pickup_date, delivery_date || null, price, base_price || null, surge_multiplier || 1.0, price_factors ? JSON.stringify(price_factors) : null, description || null]
        );
        console.log(`📦 Cargo: ${origin_city} → ${dest_city} · ${price} ₽ (kommission: 0%)`);
        setImmediate(() => { generateMatches(req.user.id).catch(console.error); });
        res.status(201).json({ id, message: 'Cargo created', price: price });
    } catch (err) {
        console.error('Create cargo error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/cargo/:id', auth, requireRole(['shipper']), async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM cargo WHERE id = $1 AND shipper_id = $2 AND status = $3 RETURNING id', [req.params.id, req.user.id, 'open']);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Cargo not found or already matched' });
        res.json({ message: 'Cargo deleted' });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// TRANSPORT
// ═══════════════════════════════════════════════════════
app.get('/api/transport', auth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, u.full_name as carrier_name, u.rating as carrier_rating
            FROM transport t JOIN users u ON t.carrier_id = u.id 
            WHERE t.status = 'available' ORDER BY t.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/transport/my', auth, requireRole(['carrier']), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM transport WHERE carrier_id = $1 ORDER BY created_at DESC', [req.user.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/transport', auth, requireRole(['carrier']), async (req, res) => {
    try {
        const { error } = transportSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });
        const { current_city, capacity_kg, vehicle_type, available_from, price_per_km, description } = req.body;
        const id = uuidv4();
        await pool.query(
            `INSERT INTO transport (id, carrier_id, current_city, capacity_kg, vehicle_type, available_from, price_per_km, description)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [id, req.user.id, current_city, capacity_kg, vehicle_type, available_from, price_per_km || null, description || null]
        );
        setImmediate(() => { generateMatches(req.user.id).catch(console.error); });
        res.status(201).json({ id, message: 'Transport listed' });
    } catch (err) {
        console.error('Create transport error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/transport/:id', auth, requireRole(['carrier']), async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM transport WHERE id = $1 AND carrier_id = $2 AND status = $3 RETURNING id', [req.params.id, req.user.id, 'available']);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Transport not found or in use' });
        res.json({ message: 'Transport deleted' });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// MATCHES
// ═══════════════════════════════════════════════════════
app.get('/api/matches', auth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT m.*, 
                c.id as cargo_id, c.origin_city, c.dest_city, c.origin_address, c.dest_address, 
                c.weight_kg, c.cargo_type, c.price as cargo_price, c.base_price, c.surge_multiplier,
                c.pickup_date, c.description as cargo_description,
                t.current_city, t.capacity_kg, t.vehicle_type, t.price_per_km,
                u1.full_name as shipper_name, u1.id as shipper_id, u1.rating as shipper_rating, u1.verified as shipper_verified,
                u2.full_name as carrier_name, u2.id as carrier_id, u2.rating as carrier_rating, u2.verified as carrier_verified,
                e.id as escrow_id, e.status as escrow_status_check, e.amount as escrow_amount, 
                e.driver_pay, e.fuel, e.tolls, e.platform_fee
            FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            JOIN users u1 ON c.shipper_id = u1.id
            JOIN users u2 ON t.carrier_id = u2.id
            LEFT JOIN escrow e ON e.match_id = m.id
            WHERE (c.shipper_id = $1 OR t.carrier_id = $1)
              AND m.status IN ('pending', 'accepted', 'in_transit', 'delivered_by_carrier', 'delivered')
            ORDER BY m.match_score DESC LIMIT 20
        `, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        console.error('Get matches error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/matches/generate', auth, async (req, res) => {
    try {
        const matches = await generateMatches(req.user.id);
        res.json({ count: matches.length });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/matches/:id/accept', auth, async (req, res) => {
    try {
        const matchId = req.params.id;
        const check = await pool.query(`
            SELECT m.*, c.shipper_id, t.carrier_id, c.id as cargo_id, t.id as transport_id, c.price
            FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND (c.shipper_id = $2 OR t.carrier_id = $2)
        `, [matchId, req.user.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Match not found' });
        const match = check.rows[0];
        if (match.status !== 'pending') return res.status(400).json({ error: 'Match already processed' });

        await pool.query('UPDATE matches SET status = $1, updated_at = NOW() WHERE id = $2', ['accepted', matchId]);
        await pool.query('UPDATE cargo SET status = $1 WHERE id = $2', ['matched', match.cargo_id]);
        await pool.query('UPDATE transport SET status = $1 WHERE id = $2', ['on_trip', match.transport_id]);
        res.json({ message: 'Match accepted' });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/matches/:id/decline', auth, async (req, res) => {
    try {
        await pool.query('UPDATE matches SET status = $1, updated_at = NOW() WHERE id = $2', ['declined', req.params.id]);
        res.json({ message: 'Match declined' });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/matches/:id/cancel', auth, async (req, res) => {
    try {
        const matchId = req.params.id;
        const check = await pool.query(`
            SELECT m.*, c.shipper_id, t.carrier_id, c.id as cargo_id, t.id as transport_id
            FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND (c.shipper_id = $2 OR t.carrier_id = $2)
        `, [matchId, req.user.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Match not found' });
        const match = check.rows[0];
        
        await pool.query('UPDATE matches SET status = $1, updated_at = NOW() WHERE id = $2', ['cancelled', matchId]);
        await pool.query('UPDATE cargo SET status = $1 WHERE id = $2', ['open', match.cargo_id]);
        await pool.query('UPDATE transport SET status = $1 WHERE id = $2', ['available', match.transport_id]);
        res.json({ message: 'Match cancelled' });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// ESCROW — 0% Kommission
// ═══════════════════════════════════════════════════════
app.post('/api/escrow/deposit', auth, requireRole(['shipper']), async (req, res) => {
    try {
        const { match_id, payment_method } = req.body;
        const check = await pool.query(`
            SELECT m.*, c.price, c.shipper_id, t.carrier_id
            FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND c.shipper_id = $2 AND m.status = 'accepted'
        `, [match_id, req.user.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Match not found or not accepted' });

        const m = check.rows[0];
        const breakdown = calculateBreakdown(m.price);

        const existing = await pool.query('SELECT id FROM escrow WHERE match_id = $1', [match_id]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Escrow already exists' });

        const id = uuidv4();
        await pool.query(
            `INSERT INTO escrow (id, match_id, shipper_id, carrier_id, amount, driver_pay, fuel, tolls, platform_fee, commission_rate, status, payment_method)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'held', $11)`,
            [id, match_id, req.user.id, m.carrier_id, breakdown.total_price, breakdown.driver_pay, breakdown.fuel_estimate, breakdown.tolls_estimate, 0, 0, payment_method || 'manual']
        );
        await pool.query('UPDATE matches SET escrow_status = $1 WHERE id = $2', ['funded', match_id]);
        
        console.log(`💰 Escrow: ${breakdown.total_price} ₽ · Kommission: 0 ₽ (FREE)`);
        res.json({ escrow_id: id, amount: breakdown.total_price, breakdown: breakdown, message: 'Payment secured · No commission' });
    } catch (err) {
        console.error('Escrow deposit error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/matches/:id/start', auth, requireRole(['carrier']), async (req, res) => {
    try {
        const matchId = req.params.id;
        const check = await pool.query(`
            SELECT m.*, e.status as escrow_status
            FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            LEFT JOIN escrow e ON e.match_id = m.id
            WHERE m.id = $1 AND t.carrier_id = $2 AND m.status = 'accepted'
        `, [matchId, req.user.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Match not found' });
        if (check.rows[0].escrow_status !== 'held') {
            return res.status(400).json({ error: 'Cannot start: escrow not funded' });
        }
        await pool.query('UPDATE matches SET status = $1, updated_at = NOW() WHERE id = $2', ['in_transit', matchId]);
        res.json({ message: 'Route started' });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/checkins/:matchId', auth, async (req, res) => {
    try {
        const { matchId } = req.params;
        const { type, lat, lng } = req.body;
        if (!['pickup', 'delivery'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
        
        const check = await pool.query(`
            SELECT m.* FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND (c.shipper_id = $2 OR t.carrier_id = $2)
        `, [matchId, req.user.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Match not found' });

        const id = uuidv4();
        await pool.query(
            `INSERT INTO checkins (id, match_id, user_id, type, lat, lng) VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, matchId, req.user.id, type, lat || null, lng || null]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/proofs/:matchId', auth, async (req, res) => {
    try {
        const { type, photo_base64 } = req.body;
        if (!['pickup', 'delivery'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
        if (!photo_base64) return res.status(400).json({ error: 'No photo' });
        
        const check = await pool.query(`
            SELECT m.* FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND (c.shipper_id = $2 OR t.carrier_id = $2)
        `, [req.params.matchId, req.user.id]);
        if (check.rows.length === 0) return res.status(403).json({ error: 'Not authorized' });
        
        const id = uuidv4();
        const truncatedUrl = 'photo_' + Date.now() + '.jpg';
        await pool.query(
            `INSERT INTO proofs (id, match_id, user_id, type, photo_url) VALUES ($1, $2, $3, $4, $5)`,
            [id, req.params.matchId, req.user.id, type, truncatedUrl]
        );
        res.json({ success: true, proof_id: id });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/matches/:id/delivered', auth, requireRole(['carrier']), async (req, res) => {
    try {
        const matchId = req.params.id;
        const check = await pool.query(`
            SELECT m.* FROM matches m
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND t.carrier_id = $2 AND m.status = 'in_transit'
        `, [matchId, req.user.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Match not found or not in transit' });

        await pool.query('UPDATE matches SET status = $1, updated_at = NOW() WHERE id = $2', ['delivered_by_carrier', matchId]);
        await pool.query('UPDATE escrow SET status = $1, updated_at = NOW() WHERE match_id = $2', ['delivered_by_carrier', matchId]);
        res.json({ message: 'Waiting for shipper confirmation' });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/matches/:id/confirm', auth, requireRole(['shipper']), async (req, res) => {
    try {
        const matchId = req.params.id;
        const check = await pool.query(`
            SELECT m.*, e.id as escrow_id, e.driver_pay
            FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            LEFT JOIN escrow e ON e.match_id = m.id
            WHERE m.id = $1 AND c.shipper_id = $2 AND m.status = 'delivered_by_carrier'
        `, [matchId, req.user.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Match not found' });

        await pool.query('UPDATE matches SET status = $1, updated_at = NOW() WHERE id = $2', ['delivered', matchId]);
        await pool.query('UPDATE escrow SET status = $1, released_at = NOW(), updated_at = NOW() WHERE match_id = $2', ['released', matchId]);
        await pool.query('UPDATE cargo SET status = $1 WHERE id = (SELECT cargo_id FROM matches WHERE id = $2)', ['delivered', matchId]);
        await pool.query('UPDATE transport SET status = $1 WHERE id = (SELECT transport_id FROM matches WHERE id = $2)', ['available', matchId]);
        res.json({ message: 'Payment released · No commission taken' });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/matches/:id/refund', auth, requireRole(['shipper']), async (req, res) => {
    try {
        const matchId = req.params.id;
        const check = await pool.query(`
            SELECT m.*, e.id as escrow_id, e.status as escrow_status, e.amount
            FROM matches m
            LEFT JOIN escrow e ON e.match_id = m.id
            WHERE m.id = $1 AND m.cargo_id IN (SELECT id FROM cargo WHERE shipper_id = $2)
        `, [matchId, req.user.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Match not found' });
        
        const m = check.rows[0];
        if (m.escrow_status !== 'held') return res.status(400).json({ error: 'No escrow to refund' });
        if (m.status === 'in_transit' || m.status === 'delivered_by_carrier') {
            return res.status(400).json({ error: 'Cannot refund after carrier started' });
        }
        
        await pool.query('UPDATE escrow SET status = $1, updated_at = NOW() WHERE match_id = $2', ['refunded', matchId]);
        await pool.query('UPDATE matches SET status = $1, escrow_status = $2, updated_at = NOW() WHERE id = $3', ['cancelled', 'refunded', matchId]);
        await pool.query('UPDATE cargo SET status = $1 WHERE id = (SELECT cargo_id FROM matches WHERE id = $2)', ['open', matchId]);
        await pool.query('UPDATE transport SET status = $1 WHERE id = (SELECT transport_id FROM matches WHERE id = $2)', ['available', matchId]);
        
        res.json({ message: 'Refund processed', amount: m.amount });
    } catch (err) {
        console.error('Refund error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════════
// DISPUTES
// ═══════════════════════════════════════════════════════
app.post('/api/disputes', auth, async (req, res) => {
    try {
        const { match_id, reason } = req.body;
        if (!match_id || !reason) return res.status(400).json({ error: 'Missing fields' });
        
        const check = await pool.query(`
            SELECT m.* FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND (c.shipper_id = $2 OR t.carrier_id = $2)
        `, [match_id, req.user.id]);
        if (check.rows.length === 0) return res.status(403).json({ error: 'Not authorized' });
        
        const id = uuidv4();
        await pool.query(
            `INSERT INTO disputes (id, match_id, opened_by, reason) VALUES ($1, $2, $3, $4)`,
            [id, match_id, req.user.id, reason]
        );
        await pool.query('UPDATE escrow SET status = $1 WHERE match_id = $2', ['disputed', match_id]);
        res.json({ dispute_id: id, message: 'Dispute opened' });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// RATINGS
// ═══════════════════════════════════════════════════════
app.post('/api/ratings', auth, async (req, res) => {
    try {
        const { match_id, rating, comment } = req.body;
        if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });

        const match = await pool.query(`
            SELECT m.*, c.shipper_id, t.carrier_id 
            FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND (c.shipper_id = $2 OR t.carrier_id = $2) AND m.status = 'delivered'
        `, [match_id, req.user.id]);
        if (match.rows.length === 0) return res.status(404).json({ error: 'Match not found or not delivered' });

        const m = match.rows[0];
        const targetId = req.user.id === m.shipper_id ? m.carrier_id : m.shipper_id;

        const existing = await pool.query('SELECT id FROM ratings WHERE match_id = $1 AND rater_id = $2', [match_id, req.user.id]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Already rated' });

        await pool.query(
            `INSERT INTO ratings (id, match_id, rater_id, target_id, rating, comment) VALUES ($1, $2, $3, $4, $5, $6)`,
            [uuidv4(), match_id, req.user.id, targetId, rating, comment || null]
        );

        await pool.query(`
            UPDATE users SET 
                rating = (SELECT AVG(rating)::DECIMAL(3,2) FROM ratings WHERE target_id = $1),
                total_ratings = (SELECT COUNT(*) FROM ratings WHERE target_id = $1)
            WHERE id = $1
        `, [targetId]);

        res.json({ message: 'Rating submitted' });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// PRICE
// ═══════════════════════════════════════════════════════
app.post('/api/price/dynamic', auth, async (req, res) => {
    try {
        const { origin_city, dest_city, weight_kg, cargo_type, pickup_date } = req.body;
        if (!origin_city || !dest_city || !weight_kg || !cargo_type) {
            return res.status(400).json({ error: 'Missing fields' });
        }
        const breakdown = await calculateDynamicPrice(origin_city, dest_city, weight_kg, cargo_type, pickup_date);
        res.json(breakdown);
    } catch (err) {
        console.error('Dynamic price error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/price/estimate', auth, async (req, res) => {
    try {
        const { origin_city, dest_city, weight_kg, cargo_type } = req.body;
        if (!origin_city || !dest_city || !weight_kg || !cargo_type) return res.status(400).json({ error: 'Missing fields' });
        const distance_km = await getDistance(origin_city, dest_city);
        const pricePerKmMap = { 'refrigerated': 55, 'van': 45, 'open': 40, 'isothermal': 50, 'tank': 60 };
        const pricePerKm = pricePerKmMap[cargo_type] || 45;
        const weightMultiplier = 1 + (weight_kg / 20) * 0.3;
        const total = Math.round(distance_km * pricePerKm * weightMultiplier);
        const breakdown = calculateBreakdown(total);
        breakdown.distance_km = distance_km;
        breakdown.price_per_km = pricePerKm;
        res.json(breakdown);
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// SHARED LOADS
// ═══════════════════════════════════════════════════════
app.get('/api/shared-loads', auth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT sl.*, c.origin_city, c.dest_city, c.pickup_date, c.cargo_type,
                   u.full_name as primary_shipper_name
            FROM shared_loads sl
            JOIN cargo c ON sl.primary_cargo_id = c.id
            JOIN users u ON c.shipper_id = u.id
            WHERE sl.status = 'open'
            ORDER BY sl.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/shared-loads', auth, requireRole(['shipper']), async (req, res) => {
    try {
        const { cargo_id } = req.body;
        const cargo = await pool.query('SELECT * FROM cargo WHERE id = $1 AND shipper_id = $2', [cargo_id, req.user.id]);
        if (cargo.rows.length === 0) return res.status(404).json({ error: 'Cargo not found' });

        const c = cargo.rows[0];
        const id = uuidv4();
        await pool.query(
            `INSERT INTO shared_loads (id, primary_cargo_id, total_weight_kg, combined_price) VALUES ($1, $2, $3, $4)`,
            [id, cargo_id, c.weight_kg, c.price]
        );
        await pool.query(
            `INSERT INTO shared_load_members (shared_load_id, cargo_id, shipper_id) VALUES ($1, $2, $3)`,
            [id, cargo_id, req.user.id]
        );
        res.status(201).json({ id, message: 'Shared load created' });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/shared-loads/:id/join', auth, requireRole(['shipper']), async (req, res) => {
    try {
        const { cargo_id } = req.body;
        const sl = await pool.query('SELECT * FROM shared_loads WHERE id = $1 AND status = $2', [req.params.id, 'open']);
        if (sl.rows.length === 0) return res.status(404).json({ error: 'Shared load not found' });

        const cargo = await pool.query('SELECT * FROM cargo WHERE id = $1 AND shipper_id = $2', [cargo_id, req.user.id]);
        if (cargo.rows.length === 0) return res.status(404).json({ error: 'Cargo not found' });

        const primary = await pool.query('SELECT * FROM cargo WHERE id = $1', [sl.rows[0].primary_cargo_id]);
        const p = primary.rows[0];

        if (p.origin_city !== cargo.rows[0].origin_city || p.dest_city !== cargo.rows[0].dest_city) {
            return res.status(400).json({ error: 'Route must match' });
        }

        const newWeight = sl.rows[0].total_weight_kg + cargo.rows[0].weight_kg;
        const newPrice = parseFloat(sl.rows[0].combined_price) + parseFloat(cargo.rows[0].price);
        const savingsPercent = 15;

        await pool.query(
            `INSERT INTO shared_load_members (shared_load_id, cargo_id, shipper_id) VALUES ($1, $2, $3)`,
            [req.params.id, cargo_id, req.user.id]
        );
        await pool.query(
            `UPDATE shared_loads SET total_weight_kg = $1, combined_price = $2, savings_percent = $3, updated_at = NOW() WHERE id = $4`,
            [newWeight, newPrice, savingsPercent, req.params.id]
        );

        res.json({ message: 'Joined shared load', savings_percent: savingsPercent });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// FUEL PRICES
// ═══════════════════════════════════════════════════════
app.get('/api/fuel/prices', auth, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM fuel_prices ORDER BY recorded_at DESC LIMIT 30`);
        const current = await getSetting('diesel_price', '68');
        res.json({ current, history: result.rows });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/diesel-price', auth, requireRole(['admin']), async (req, res) => {
    try {
        const { price } = req.body;
        if (!price || price < 30 || price > 200) return res.status(400).json({ error: 'Invalid price (30-200)' });
        await setSetting('diesel_price', price);
        await pool.query(`INSERT INTO fuel_prices (price_per_liter, source) VALUES ($1, 'manual')`, [price]);
        console.log(`⛽ Diesel price: ${price} ₽/L`);
        res.json({ success: true, price });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// ETA + TRACKING
// ═══════════════════════════════════════════════════════
app.get('/api/matches/:id/eta', auth, async (req, res) => {
    try {
        const m = await pool.query(`
            SELECT c.origin_city, c.dest_city FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            WHERE m.id = $1
        `, [req.params.id]);
        if (m.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        
        const distance = await getDistance(m.rows[0].origin_city, m.rows[0].dest_city);
        const avgSpeed = 70;
        const hours = Math.round(distance / avgSpeed);
        const eta = new Date(Date.now() + hours * 3600 * 1000);
        
        res.json({ distance_km: distance, hours, eta: eta.toISOString() });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/tracking/:matchId', auth, async (req, res) => {
    try {
        const { matchId } = req.params;
        const { lat, lng, speed, heading } = req.body;
        const check = await pool.query(`
            SELECT m.* FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND (c.shipper_id = $2 OR t.carrier_id = $2)
        `, [matchId, req.user.id]);
        if (check.rows.length === 0) return res.status(403).json({ error: 'Not authorized' });

        await pool.query(`INSERT INTO tracking (match_id, lat, lng, speed, heading) VALUES ($1, $2, $3, $4, $5)`, [matchId, lat, lng, speed || null, heading || null]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/tracking/:matchId', auth, async (req, res) => {
    try {
        const result = await pool.query('SELECT lat, lng, speed, heading, created_at FROM tracking WHERE match_id = $1 ORDER BY created_at ASC', [req.params.matchId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/tracking/:matchId/latest', auth, async (req, res) => {
    try {
        const result = await pool.query('SELECT lat, lng, speed, heading, created_at FROM tracking WHERE match_id = $1 ORDER BY created_at DESC LIMIT 1', [req.params.matchId]);
        res.json(result.rows[0] || null);
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════════════════════
app.get('/api/messages/conversations', auth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT DISTINCT ON (m.match_id)
                m.match_id, m.content as last_message, m.created_at as last_message_time,
                CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END as other_user_id,
                CASE WHEN m.sender_id = $1 THEN u2.full_name ELSE u1.full_name END as other_user_name,
                c.origin_city, c.dest_city,
                (SELECT COUNT(*) FROM messages WHERE match_id = m.match_id AND receiver_id = $1 AND read_at IS NULL) as unread_count
            FROM messages m
            JOIN matches mt ON m.match_id = mt.id
            JOIN cargo c ON mt.cargo_id = c.id
            JOIN users u1 ON m.sender_id = u1.id
            JOIN users u2 ON m.receiver_id = u2.id
            WHERE m.sender_id = $1 OR m.receiver_id = $1
            ORDER BY m.match_id, m.created_at DESC
        `, [req.user.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/messages/unread/count', auth, async (req, res) => {
    try {
        const result = await pool.query('SELECT COUNT(*) as count FROM messages WHERE receiver_id = $1 AND read_at IS NULL', [req.user.id]);
        res.json({ count: parseInt(result.rows[0].count) });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/messages/:matchId', auth, async (req, res) => {
    try {
        const { matchId } = req.params;
        const check = await pool.query(`
            SELECT m.* FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND (c.shipper_id = $2 OR t.carrier_id = $2)
        `, [matchId, req.user.id]);
        if (check.rows.length === 0) return res.status(403).json({ error: 'Not authorized' });

        const result = await pool.query('SELECT * FROM messages WHERE match_id = $1 ORDER BY created_at ASC', [matchId]);
        await pool.query('UPDATE messages SET read_at = NOW() WHERE match_id = $1 AND receiver_id = $2 AND read_at IS NULL', [matchId, req.user.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/messages', auth, async (req, res) => {
    try {
        const { match_id, receiver_id, content } = req.body;
        if (!match_id || !receiver_id || !content) return res.status(400).json({ error: 'Missing fields' });

        const check = await pool.query(`
            SELECT m.* FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND (c.shipper_id = $2 OR t.carrier_id = $2)
        `, [match_id, req.user.id]);
        if (check.rows.length === 0) return res.status(403).json({ error: 'Not authorized' });

        const id = uuidv4();
        await pool.query(`INSERT INTO messages (id, sender_id, receiver_id, match_id, content) VALUES ($1, $2, $3, $4, $5)`,
            [id, req.user.id, receiver_id, match_id, content]);
        res.status(201).json({ id });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════
app.get('/api/stats', auth, async (req, res) => {
    try {
        const cargoOpen = await pool.query("SELECT COUNT(*) FROM cargo WHERE status = 'open'");
        const transportAvail = await pool.query("SELECT COUNT(*) FROM transport WHERE status = 'available'");
        const matchesPending = await pool.query("SELECT COUNT(*) FROM matches WHERE status = 'pending'");
        const completed = await pool.query("SELECT COUNT(*) FROM matches WHERE status = 'delivered'");
        const diesel = await getSetting('diesel_price', '68');
        res.json({
            open_cargo: parseInt(cargoOpen.rows[0].count),
            available_transport: parseInt(transportAvail.rows[0].count),
            pending_matches: parseInt(matchesPending.rows[0].count),
            completed_shipments: parseInt(completed.rows[0].count),
            commission_rate: 0,
            diesel_price: parseFloat(diesel)
        });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// FRONTEND
// ═══════════════════════════════════════════════════════
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ═══════════════════════════════════════════════════════
// MIGRATION
// ═══════════════════════════════════════════════════════
const initDb = async () => {
    try {
        const schemaPath = path.join(__dirname, 'schema.sql');
        if (!fs.existsSync(schemaPath)) throw new Error('schema.sql not found');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        const statements = schema.split(';').filter(s => s.trim().length > 0);
        const client = await pool.connect();
        try {
            for (let stmt of statements) {
                await client.query(stmt + ';').catch(err => {
                    if (!err.message.includes('already exists') && !err.message.includes('duplicate')) {
                        console.log('⚠️', err.message.substring(0, 100));
                    }
                });
            }
            console.log('✅ Schema applied');
        } finally { client.release(); }
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        throw err;
    }
};

(async () => {
    try {
        await initDb();
        app.listen(PORT, () => {
            console.log('');
            console.log(`🚛 CargoThink v4.0 running on ${PORT}`);
            console.log(`💰 Kommission: 0% (FREE)`);
            console.log(`⛽ Dynamic Pricing: ON`);
            console.log(`🎯 Ziel: 20 Nutzer in 30 Tagen`);
            console.log('');
        });
    } catch (err) {
        console.error('🚨 Startup aborted:', err.message);
        process.exit(1);
    }
})();

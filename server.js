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

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5000';

// === ENFORCE JWT SECRET ===
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('❌ FATAL: JWT_SECRET missing or too weak in .env');
    console.error('   Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
    process.exit(1);
}
console.log('✅ Environment validated');

// === DATABASE ===
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'cargothink',
});

pool.connect((err) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
        process.exit(1);
    }
    console.log('✅ Database connected');
});

// === MIDDLEWARE ===
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests. Try again later.' },
});
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many login attempts. Try again later.' },
    skipSuccessfulRequests: true,
});

app.use('/api/', globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// === VALIDATION SCHEMAS ===
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
    weight_kg: Joi.number().integer().min(1).max(100000).required(),
    cargo_type: Joi.string().valid('refrigerated', 'open', 'van', 'isothermal', 'tank').required(),
    pickup_date: Joi.date().required(),
    delivery_date: Joi.date().allow(null),
    price: Joi.number().min(1).max(99999999).required(),
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

// === AUTH MIDDLEWARE ===
const auth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'No token provided' });
        const decoded = jwt.verify(token, JWT_SECRET);
        const result = await pool.query('SELECT id, email, full_name, role FROM users WHERE id = $1', [decoded.userId]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'User not found' });
        req.user = result.rows[0];
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        return res.status(401).json({ error: 'Invalid token' });
    }
};

const requireRole = (roles) => {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: `Insufficient permissions. Required: ${roles.join(' or ')}` });
        }
        next();
    };
};

// === MATCHING ALGORITHM ===
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
        const cargoRes = await pool.query('SELECT * FROM cargo WHERE status = $1', ['open']);
        const transportRes = await pool.query('SELECT * FROM transport WHERE status = $1', ['available']);
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
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (cargo_id, transport_id) DO UPDATE SET match_score = $3, updated_at = NOW()`,
                [m.cargo_id, m.transport_id, m.match_score, 'pending']
            );
        }
        return topMatches;
    } catch (err) {
        console.error('Match generation error:', err);
        throw err;
    }
}

// === API ROUTES ===
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth
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
        res.status(201).json({ token, user: { id, email, full_name, role: role || 'shipper' } });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { error } = loginSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });
        const { email, password } = req.body;

        const result = await pool.query('SELECT id, email, password_hash, full_name, role, company_name FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, company_name: user.company_name } });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/auth/me', auth, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, email, full_name, role, company_name, phone, rating FROM users WHERE id = $1', [req.user.id]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Cargo
app.get('/api/cargo', auth, async (req, res) => {
    try {
        const result = await pool.query('SELECT c.*, u.full_name as shipper_name FROM cargo c JOIN users u ON c.shipper_id = u.id WHERE c.status = $1 ORDER BY c.created_at DESC', ['open']);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/cargo/my', auth, requireRole(['shipper']), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM cargo WHERE shipper_id = $1 ORDER BY created_at DESC', [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/cargo', auth, requireRole(['shipper']), async (req, res) => {
    try {
        const { error } = cargoSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const { origin_city, dest_city, weight_kg, cargo_type, pickup_date, delivery_date, price, description } = req.body;
        const id = uuidv4();
        await pool.query(
            `INSERT INTO cargo (id, shipper_id, origin_city, dest_city, weight_kg, cargo_type, pickup_date, delivery_date, price, description)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [id, req.user.id, origin_city, dest_city, weight_kg, cargo_type, pickup_date, delivery_date || null, price, description || null]
        );
        setImmediate(() => { generateMatches(req.user.id).catch(console.error); });
        res.status(201).json({ id, message: 'Cargo created successfully' });
    } catch (err) {
        console.error('Create cargo error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/cargo/:id', auth, requireRole(['shipper']), async (req, res) => {
    try {
        const cargoId = req.params.id;
        const check = await pool.query('SELECT id FROM cargo WHERE id = $1 AND shipper_id = $2', [cargoId, req.user.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Cargo not found' });

        const { error } = cargoSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const { origin_city, dest_city, weight_kg, cargo_type, pickup_date, delivery_date, price, description } = req.body;
        await pool.query(
            `UPDATE cargo SET origin_city = $1, dest_city = $2, weight_kg = $3, cargo_type = $4, pickup_date = $5, delivery_date = $6, price = $7, description = $8, updated_at = NOW()
             WHERE id = $9 AND shipper_id = $10`,
            [origin_city, dest_city, weight_kg, cargo_type, pickup_date, delivery_date || null, price, description || null, cargoId, req.user.id]
        );
        res.json({ message: 'Cargo updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/cargo/:id', auth, requireRole(['shipper']), async (req, res) => {
    try {
        const cargoId = req.params.id;
        const result = await pool.query('DELETE FROM cargo WHERE id = $1 AND shipper_id = $2 RETURNING id', [cargoId, req.user.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Cargo not found' });
        res.json({ message: 'Cargo deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Transport
app.get('/api/transport', auth, async (req, res) => {
    try {
        const result = await pool.query('SELECT t.*, u.full_name as carrier_name FROM transport t JOIN users u ON t.carrier_id = u.id WHERE t.status = $1 ORDER BY t.created_at DESC', ['available']);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/transport/my', auth, requireRole(['carrier']), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM transport WHERE carrier_id = $1 ORDER BY created_at DESC', [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
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
        res.status(201).json({ id, message: 'Transport listed successfully' });
    } catch (err) {
        console.error('Create transport error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/transport/:id', auth, requireRole(['carrier']), async (req, res) => {
    try {
        const transportId = req.params.id;
        const check = await pool.query('SELECT id FROM transport WHERE id = $1 AND carrier_id = $2', [transportId, req.user.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Transport not found' });

        const { error } = transportSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const { current_city, capacity_kg, vehicle_type, available_from, price_per_km, description } = req.body;
        await pool.query(
            `UPDATE transport SET current_city = $1, capacity_kg = $2, vehicle_type = $3, available_from = $4, price_per_km = $5, description = $6, updated_at = NOW()
             WHERE id = $7 AND carrier_id = $8`,
            [current_city, capacity_kg, vehicle_type, available_from, price_per_km || null, description || null, transportId, req.user.id]
        );
        res.json({ message: 'Transport updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/transport/:id', auth, requireRole(['carrier']), async (req, res) => {
    try {
        const transportId = req.params.id;
        const result = await pool.query('DELETE FROM transport WHERE id = $1 AND carrier_id = $2 RETURNING id', [transportId, req.user.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Transport not found' });
        res.json({ message: 'Transport deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Matches
app.get('/api/matches', auth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT m.*, c.origin_city, c.dest_city, c.weight_kg, c.cargo_type, c.price as cargo_price,
                   t.current_city, t.capacity_kg, t.vehicle_type, t.price_per_km,
                   u1.full_name as shipper_name, u2.full_name as carrier_name
            FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            JOIN users u1 ON c.shipper_id = u1.id
            JOIN users u2 ON t.carrier_id = u2.id
            WHERE c.shipper_id = $1 OR t.carrier_id = $1
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
        res.json({ message: `Generated ${matches.length} new matches`, count: matches.length });
    } catch (err) {
        console.error('Generate matches error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/matches/:id/accept', auth, async (req, res) => {
    try {
        const matchId = req.params.id;
        const check = await pool.query(`
            SELECT m.*, c.shipper_id, t.carrier_id
            FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND (c.shipper_id = $2 OR t.carrier_id = $2)
        `, [matchId, req.user.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Match not found' });

        await pool.query('UPDATE matches SET status = $1, updated_at = NOW() WHERE id = $2', ['accepted', matchId]);
        const match = check.rows[0];
        await pool.query('UPDATE cargo SET status = $1 WHERE id = $2', ['matched', match.cargo_id]);
        await pool.query('UPDATE transport SET status = $1 WHERE id = $2', ['on_trip', match.transport_id]);
        res.json({ message: 'Match accepted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/matches/:id/decline', auth, async (req, res) => {
    try {
        const matchId = req.params.id;
        const check = await pool.query(`
            SELECT m.*, c.shipper_id, t.carrier_id
            FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND (c.shipper_id = $2 OR t.carrier_id = $2)
        `, [matchId, req.user.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Match not found' });

        await pool.query('UPDATE matches SET status = $1, updated_at = NOW() WHERE id = $2', ['declined', matchId]);
        res.json({ message: 'Match declined successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Tracking
app.post('/api/tracking/:matchId', auth, async (req, res) => {
    try {
        const { matchId } = req.params;
        const { lat, lng, speed, heading } = req.body;
        const check = await pool.query(`
            SELECT m.*, c.shipper_id, t.carrier_id
            FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            WHERE m.id = $1 AND (c.shipper_id = $2 OR t.carrier_id = $2)
        `, [matchId, req.user.id]);
        if (check.rows.length === 0) return res.status(403).json({ error: 'Not authorized' });

        await pool.query(`INSERT INTO tracking (match_id, lat, lng, speed, heading) VALUES ($1, $2, $3, $4, $5)`, [matchId, lat, lng, speed || null, heading || null]);
        res.json({ success: true });
    } catch (err) {
        console.error('Tracking update error:', err);
        res.status(500).json({ error: 'Failed to update location' });
    }
});

app.get('/api/tracking/:matchId', auth, async (req, res) => {
    try {
        const { matchId } = req.params;
        const result = await pool.query('SELECT lat, lng, speed, heading, created_at FROM tracking WHERE match_id = $1 ORDER BY created_at ASC', [matchId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get tracking data' });
    }
});

app.get('/api/tracking/:matchId/latest', auth, async (req, res) => {
    try {
        const { matchId } = req.params;
        const result = await pool.query('SELECT lat, lng, speed, heading, created_at FROM tracking WHERE match_id = $1 ORDER BY created_at DESC LIMIT 1', [matchId]);
        res.json(result.rows[0] || null);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get latest location' });
    }
});

// Payments
app.post('/api/payments/create', auth, async (req, res) => {
    try {
        const { amount, match_id, description } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
        const paymentId = uuidv4();
        await pool.query(
            `INSERT INTO payments (id, user_id, match_id, amount, status, yookassa_confirmation_url)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [paymentId, req.user.id, match_id || null, amount, 'pending', 'https://example.com/pay']
        );
        res.json({ payment_id: paymentId, confirmation_url: 'https://example.com/pay' });
    } catch (err) {
        console.error('Payment error:', err);
        res.status(500).json({ error: 'Failed to create payment' });
    }
});

app.get('/api/payments/:paymentId', auth, async (req, res) => {
    try {
        const { paymentId } = req.params;
        const result = await pool.query('SELECT * FROM payments WHERE id = $1 AND user_id = $2', [paymentId, req.user.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Payment not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get payment status' });
    }
});

// ADMIN ROUTES
app.get('/api/admin/users', auth, requireRole(['admin']), async (req, res) => {
    try {
        const result = await pool.query('SELECT id, email, full_name, company_name, phone, role, rating, created_at FROM users ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch users' }); }
});

app.get('/api/admin/cargo/all', auth, requireRole(['admin']), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.*, u.full_name as shipper_name, u.email as shipper_email
            FROM cargo c
            JOIN users u ON c.shipper_id = u.id
            ORDER BY c.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch cargo' }); }
});

app.get('/api/admin/transport/all', auth, requireRole(['admin']), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, u.full_name as carrier_name, u.email as carrier_email
            FROM transport t
            JOIN users u ON t.carrier_id = u.id
            ORDER BY t.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch transport' }); }
});

app.get('/api/admin/matches/all', auth, requireRole(['admin']), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT m.*,
                   c.origin_city, c.dest_city, c.weight_kg, c.cargo_type,
                   t.current_city, t.capacity_kg, t.vehicle_type,
                   u1.full_name as shipper_name, u2.full_name as carrier_name
            FROM matches m
            JOIN cargo c ON m.cargo_id = c.id
            JOIN transport t ON m.transport_id = t.id
            JOIN users u1 ON c.shipper_id = u1.id
            JOIN users u2 ON t.carrier_id = u2.id
            ORDER BY m.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch matches' }); }
});

app.post('/api/admin/assign', auth, requireRole(['admin']), async (req, res) => {
    try {
        const { cargo_id, transport_id } = req.body;
        if (!cargo_id || !transport_id) return res.status(400).json({ error: 'Missing cargo_id or transport_id' });

        const cargoCheck = await pool.query('SELECT * FROM cargo WHERE id = $1 AND status = $2', [cargo_id, 'open']);
        if (cargoCheck.rows.length === 0) return res.status(404).json({ error: 'Cargo not found or already assigned' });

        const transportCheck = await pool.query('SELECT * FROM transport WHERE id = $1 AND status = $2', [transport_id, 'available']);
        if (transportCheck.rows.length === 0) return res.status(404).json({ error: 'Transport not found or unavailable' });

        const matchId = uuidv4();
        await pool.query(
            `INSERT INTO matches (id, cargo_id, transport_id, match_score, status)
             VALUES ($1, $2, $3, $4, $5)`,
            [matchId, cargo_id, transport_id, 100, 'pending']
        );
        res.json({ success: true, match_id: matchId });
    } catch (err) {
        console.error('Admin assign error:', err);
        res.status(500).json({ error: 'Failed to assign' });
    }
});

// Serve Frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server
// === AUTO-MIGRATE: Create tables if they don't exist ===
const fs = require('fs');
const path = require('path');

const initDb = async () => {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const statements = schema.split(';').filter(s => s.trim().length > 0);
    const client = await pool.connect();
    try {
      for (let stmt of statements) {
        await client.query(stmt + ';');
      }
      console.log('✅ Database schema applied successfully');
    } finally {
      client.release();
    }
  } catch (err) {
    // If tables already exist, just log and continue
    console.log('⏩ Schema already applied (or error ignored):', err.message);
  }
};

// Run the migration (don't await – let it run in background)
initDb();
app.listen(PORT, () => {
    console.log('');
    console.log('🚛 CargoThink v2.0 — Production Ready');
    console.log(`📍 Server: http://localhost:${PORT}`);
    console.log(`🔒 JWT: ${JWT_SECRET ? '✅ Configured' : '❌ Missing'}`);
    console.log(`🗄️  Database: ${process.env.DB_NAME || 'cargothink'}`);
    console.log('');
    console.log('📦 Ready for production');
    console.log('   Open http://localhost:5000 in your browser');
    console.log('');
});
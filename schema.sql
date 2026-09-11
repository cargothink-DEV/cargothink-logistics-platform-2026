CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    company_name TEXT,
    phone TEXT,
    role TEXT CHECK (role IN ('shipper', 'carrier', 'admin')) DEFAULT 'shipper',
    rating DECIMAL(3,2) DEFAULT 0,
    total_ratings INTEGER DEFAULT 0,
    verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS total_ratings INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS cargo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipper_id UUID REFERENCES users(id) ON DELETE CASCADE,
    origin_city TEXT NOT NULL,
    dest_city TEXT NOT NULL,
    origin_address TEXT,
    dest_address TEXT,
    weight_kg INTEGER NOT NULL,
    cargo_type TEXT NOT NULL,
    pickup_date DATE NOT NULL,
    delivery_date DATE,
    price DECIMAL(12,2) NOT NULL,
    base_price DECIMAL(12,2),
    surge_multiplier DECIMAL(4,2) DEFAULT 1.0,
    price_factors JSONB,
    status TEXT DEFAULT 'open',
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE cargo ADD COLUMN IF NOT EXISTS origin_address TEXT;
ALTER TABLE cargo ADD COLUMN IF NOT EXISTS dest_address TEXT;
ALTER TABLE cargo ADD COLUMN IF NOT EXISTS base_price DECIMAL(12,2);
ALTER TABLE cargo ADD COLUMN IF NOT EXISTS surge_multiplier DECIMAL(4,2) DEFAULT 1.0;
ALTER TABLE cargo ADD COLUMN IF NOT EXISTS price_factors JSONB;

CREATE TABLE IF NOT EXISTS transport (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    carrier_id UUID REFERENCES users(id) ON DELETE CASCADE,
    current_city TEXT NOT NULL,
    capacity_kg INTEGER NOT NULL,
    vehicle_type TEXT NOT NULL,
    available_from DATE NOT NULL,
    price_per_km DECIMAL(8,2),
    status TEXT DEFAULT 'available',
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cargo_id UUID REFERENCES cargo(id) ON DELETE CASCADE,
    transport_id UUID REFERENCES transport(id) ON DELETE CASCADE,
    match_score DECIMAL(5,2) NOT NULL,
    status TEXT DEFAULT 'pending',
    escrow_status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(cargo_id, transport_id)
);

ALTER TABLE matches ADD COLUMN IF NOT EXISTS escrow_status TEXT DEFAULT 'pending';

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID REFERENCES users(id) ON DELETE CASCADE,
    receiver_id UUID REFERENCES users(id) ON DELETE CASCADE,
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS escrow (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    shipper_id UUID REFERENCES users(id),
    carrier_id UUID REFERENCES users(id),
    amount DECIMAL(12,2) NOT NULL,
    driver_pay DECIMAL(12,2),
    fuel DECIMAL(12,2),
    tolls DECIMAL(12,2),
    platform_fee DECIMAL(12,2),
    commission_rate DECIMAL(5,4) DEFAULT 0.10,
    currency TEXT DEFAULT 'RUB',
    status TEXT DEFAULT 'held',
    payment_method TEXT,
    payment_reference TEXT,
    released_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE escrow ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE escrow ADD COLUMN IF NOT EXISTS payment_reference TEXT;
ALTER TABLE escrow ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(5,4) DEFAULT 0.10;

CREATE TABLE IF NOT EXISTS ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    rater_id UUID REFERENCES users(id) ON DELETE CASCADE,
    target_id UUID REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(match_id, rater_id)
);

CREATE TABLE IF NOT EXISTS checkins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    type TEXT CHECK (type IN ('pickup', 'delivery')),
    lat DECIMAL(10,8),
    lng DECIMAL(11,8),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proofs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    type TEXT CHECK (type IN ('pickup', 'delivery')),
    photo_url TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    opened_by UUID REFERENCES users(id),
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    resolution TEXT,
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tracking (
    id SERIAL PRIMARY KEY,
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    lat DECIMAL(10,8) NOT NULL,
    lng DECIMAL(11,8) NOT NULL,
    speed DECIMAL(5,2),
    heading INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fuel_prices (
    id SERIAL PRIMARY KEY,
    region TEXT DEFAULT 'russia',
    price_per_liter DECIMAL(6,2) NOT NULL,
    source TEXT DEFAULT 'manual',
    recorded_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO app_settings (key, value) VALUES 
    ('diesel_price', '68'),
    ('diesel_reference', '60'),
    ('commission_rate', '0.10'),
    ('surge_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS shared_loads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    primary_cargo_id UUID REFERENCES cargo(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'open',
    total_weight_kg INTEGER DEFAULT 0,
    combined_price DECIMAL(12,2) DEFAULT 0,
    savings_percent DECIMAL(4,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shared_load_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shared_load_id UUID REFERENCES shared_loads(id) ON DELETE CASCADE,
    cargo_id UUID REFERENCES cargo(id) ON DELETE CASCADE,
    shipper_id UUID REFERENCES users(id),
    joined_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(shared_load_id, cargo_id)
);

CREATE TABLE IF NOT EXISTS city_distances (
    id SERIAL PRIMARY KEY,
    city_a TEXT NOT NULL,
    city_b TEXT NOT NULL,
    distance_km INTEGER NOT NULL,
    UNIQUE(city_a, city_b)
);

INSERT INTO city_distances (city_a, city_b, distance_km) VALUES
('Москва', 'Санкт-Петербург', 705),('Москва', 'Казань', 820),('Москва', 'Уфа', 1350),
('Москва', 'Екатеринбург', 1790),('Москва', 'Новосибирск', 3350),('Москва', 'Краснодар', 1350),
('Москва', 'Нижний Новгород', 420),('Москва', 'Самара', 1050),('Москва', 'Ростов-на-Дону', 1080),
('Москва', 'Воронеж', 520),('Москва', 'Волгоград', 970),('Москва', 'Пермь', 1390),
('Москва', 'Челябинск', 1760),('Москва', 'Омск', 2700),('Москва', 'Красноярск', 4100),
('Москва', 'Иркутск', 5200),('Москва', 'Владивосток', 9100),('Москва', 'Хабаровск', 8300),
('Санкт-Петербург', 'Казань', 1520),('Санкт-Петербург', 'Москва', 705),('Санкт-Петербург', 'Новосибирск', 4000),
('Казань', 'Уфа', 530),('Казань', 'Екатеринбург', 1000),('Екатеринбург', 'Новосибирск', 1560),
('Екатеринбург', 'Челябинск', 210),('Новосибирск', 'Красноярск', 800),('Красноярск', 'Иркутск', 1080),
('Ростов-на-Дону', 'Краснодар', 270),('Самара', 'Уфа', 460),('Нижний Новгород', 'Казань', 400)
ON CONFLICT (city_a, city_b) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_cargo_status ON cargo(status);
CREATE INDEX IF NOT EXISTS idx_cargo_shipper ON cargo(shipper_id);
CREATE INDEX IF NOT EXISTS idx_transport_status ON transport(status);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_messages_match_id ON messages(match_id);
CREATE INDEX IF NOT EXISTS idx_tracking_match_id ON tracking(match_id);
CREATE INDEX IF NOT EXISTS idx_fuel_prices_date ON fuel_prices(recorded_at);

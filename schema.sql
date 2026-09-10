CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    company_name TEXT,
    phone TEXT,
    role TEXT CHECK (role IN ('shipper', 'carrier', 'admin')) DEFAULT 'shipper',
    rating DECIMAL(3,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

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
    status TEXT DEFAULT 'open',
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE cargo ADD COLUMN IF NOT EXISTS origin_address TEXT;
ALTER TABLE cargo ADD COLUMN IF NOT EXISTS dest_address TEXT;

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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(cargo_id, transport_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID REFERENCES users(id) ON DELETE CASCADE,
    receiver_id UUID REFERENCES users(id) ON DELETE CASCADE,
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    amount DECIMAL(12,2) NOT NULL,
    currency TEXT DEFAULT 'RUB',
    status TEXT DEFAULT 'pending',
    payment_method TEXT,
    yookassa_payment_id TEXT,
    yookassa_confirmation_url TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
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

CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT DEFAULT 'premium',
    status TEXT DEFAULT 'trial',
    trial_end TIMESTAMP,
    subscription_end TIMESTAMP,
    payment_id UUID REFERENCES payments(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS city_distances (
    id SERIAL PRIMARY KEY,
    city_a TEXT NOT NULL,
    city_b TEXT NOT NULL,
    distance_km INTEGER NOT NULL,
    UNIQUE(city_a, city_b)
);

INSERT INTO city_distances (city_a, city_b, distance_km) VALUES
('Москва', 'Санкт-Петербург', 705),
('Москва', 'Казань', 820),
('Москва', 'Уфа', 1350),
('Москва', 'Екатеринбург', 1790),
('Москва', 'Новосибирск', 3350),
('Москва', 'Краснодар', 1350),
('Москва', 'Нижний Новгород', 420),
('Москва', 'Самара', 1050),
('Москва', 'Ростов-на-Дону', 1080),
('Москва', 'Воронеж', 520),
('Москва', 'Волгоград', 970),
('Москва', 'Пермь', 1390),
('Москва', 'Челябинск', 1760),
('Москва', 'Омск', 2700),
('Москва', 'Красноярск', 4100),
('Москва', 'Иркутск', 5200),
('Москва', 'Владивосток', 9100),
('Москва', 'Хабаровск', 8300),
('Санкт-Петербург', 'Казань', 1520),
('Санкт-Петербург', 'Москва', 705),
('Санкт-Петербург', 'Новосибирск', 4000),
('Казань', 'Уфа', 530),
('Казань', 'Екатеринбург', 1000),
('Екатеринбург', 'Новосибирск', 1560),
('Екатеринбург', 'Челябинск', 210),
('Новосибирск', 'Красноярск', 800),
('Красноярск', 'Иркутск', 1080),
('Ростов-на-Дону', 'Краснодар', 270),
('Самара', 'Уфа', 460),
('Нижний Новгород', 'Казань', 400)
ON CONFLICT (city_a, city_b) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_cargo_status ON cargo(status);
CREATE INDEX IF NOT EXISTS idx_transport_status ON transport(status);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_messages_match_id ON messages(match_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_tracking_match_id ON tracking(match_id);

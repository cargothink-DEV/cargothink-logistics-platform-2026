CREATE DATABASE cargothink;
\c cargothink;

CREATE TABLE users (
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

CREATE TABLE cargo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipper_id UUID REFERENCES users(id) ON DELETE CASCADE,
    origin_city TEXT NOT NULL,
    dest_city TEXT NOT NULL,
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

CREATE TABLE transport (
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

CREATE TABLE matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cargo_id UUID REFERENCES cargo(id) ON DELETE CASCADE,
    transport_id UUID REFERENCES transport(id) ON DELETE CASCADE,
    match_score DECIMAL(5,2) NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(cargo_id, transport_id)
);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID REFERENCES users(id) ON DELETE CASCADE,
    receiver_id UUID REFERENCES users(id) ON DELETE CASCADE,
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE payments (
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

CREATE TABLE tracking (
    id SERIAL PRIMARY KEY,
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    lat DECIMAL(10,8) NOT NULL,
    lng DECIMAL(11,8) NOT NULL,
    speed DECIMAL(5,2),
    heading INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE subscriptions (
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

CREATE INDEX idx_cargo_status ON cargo(status);
CREATE INDEX idx_transport_status ON transport(status);
CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_messages_match_id ON messages(match_id);
CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_tracking_match_id ON tracking(match_id);
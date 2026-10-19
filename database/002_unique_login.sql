-- Login do MVP utiliza e-mail globalmente único até haver seletor de organização.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_global_unique ON users(lower(email));

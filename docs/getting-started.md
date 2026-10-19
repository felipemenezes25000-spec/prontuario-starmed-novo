# Rodando localmente

Pré-requisitos: Node.js 22+, npm, Docker Desktop/Engine e Docker Compose.

1. `cp .env.example .env` (no PowerShell: `Copy-Item .env.example .env`).
2. Altere AUTH_SECRET com valor aleatório (ex.: `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`).
3. Defina POSTGRES_PASSWORD=change_me para ambiente descartável local, e mantenha DATABASE_URL coerente.
4. Preencha BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD (senha única >= 12 caracteres).
5. `docker compose up -d` (schema é aplicado apenas na **primeira criação** do volume).
6. `npm install`.
7. `npm run bootstrap` para criar a organização e a conta admin inicial.
8. Em dois terminais: `npm run dev:api` e `npm run dev:web`.
9. Abra http://localhost:5173, entre com admin; em Equipe, cadastre um médico; saia e entre como médico para criar atendimento, salvar/atestar evolução.

Observações:
- O login retorna Bearer token em memória da aba. Não usar em produção sem IAM/OIDC/MFA, recuperação, rate limiting e controles de sessão.
- O sistema não possui migração automática após o schema inicial. Scripts de schema não devem ser reaplicados em banco existente.
- Banco, senha e certificados desta documentação são EXEMPLOS locais, jamais para infraestrutura pública.
- O demo não é certificado SBIS/CFM nem comprovadamente compatível com LGPD/HIPAA.
- Testes unitários: `npm test`. Build: `npm run build`. Exigem dependências instaladas.
- Agendamento ainda não impede dupla marcação; controle de recursos/slots entra na próxima fase.
- IA somente após configurar URL/modelo/chave, contrato de operador e `organizations.ai_enabled=true` após aprovação administrativa.
- Sincronização offline usa cifra AES-GCM por rascunho em IndexedDB. Não habilitar para PHI real sem gestão de dispositivos, wipe e pentest.

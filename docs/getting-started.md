# Rodando localmente

Pré-requisitos: Node.js 22+, npm, Docker Desktop/Engine e Docker Compose.

1. `cp .env.example .env` (no PowerShell: `Copy-Item .env.example .env`).
2. Altere AUTH_SECRET com valor aleatório (ex.: `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`).
3. Defina POSTGRES_PASSWORD com senha forte e mantenha DATABASE_URL coerente. O valor de exemplo é apenas para ambiente descartável local.
4. Preencha BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD (senha única >= 12 caracteres).
5. `docker compose up -d` (apenas o banco; o schema é aplicado no próximo passo).
6. `npm install`.
7. `npm run migrate` — aplica `database/schema.sql` + `002`..`014` na ordem e registra versão/checksum em `schema_migrations` (idempotente; falha fechada se um arquivo já aplicado mudou).
   - Volume antigo (criado antes do runner, com tabelas mas sem `schema_migrations`): o runner **recusa** reexecutar. Após backup e conferência, registre uma única vez com `npm run migrate -- --adopt` (nunca em produção sem revisão).
8. `npm run bootstrap` para criar a organização e a conta admin inicial.
9. Em dois terminais: `npm run dev:api` e `npm run dev:web`.
10. Abra http://localhost:5173, entre com admin; em Equipe, cadastre um médico; saia e entre como médico para criar atendimento, salvar/atestar evolução.

Observações:
- O login retorna Bearer token em memória da aba. Não usar em produção sem IAM/OIDC/MFA, recuperação, rate limiting e controles de sessão.
- Migrações só através do runner versionado (`npm run migrate`). Nunca reaplique `schema.sql` em banco populado e nunca edite um `.sql` já aplicado — crie um novo `NNN_arquivo.sql`.
- Banco, senha e certificados desta documentação são EXEMPLOS locais, jamais para infraestrutura pública.
- O demo não é certificado SBIS/CFM nem comprovadamente compatível com LGPD/HIPAA.
- Testes unitários: `npm test`. Build: `npm run build`. Exigem dependências instaladas.
- Dupla marcação é impedida por restrição PostgreSQL (EXCLUDE/GiST, `database/003_clinical_extensions.sql`); concorrência real sob carga ainda não foi medida nesta rodada.
- IA somente após configurar URL/modelo/chave, contrato de operador e `organizations.ai_enabled=true` após aprovação administrativa.
- Sincronização offline usa cifra AES-GCM por rascunho em IndexedDB. Não habilitar para PHI real sem gestão de dispositivos, wipe e pentest.

## Migrações e bases existentes
Todas as migrações (`002`..`014`) são aplicadas pelo runner versionado `npm run migrate`
(transacional, ordem determinística, checksum em `schema_migrations`, `--dry-run` para
planejar, `--adopt` para registrar uma base antiga). Os comandos manuais via `psql` para
003/004 caíram em desuso: em base antiga, prefira backup + `npm run migrate -- --adopt`
e, se faltar alguma mudança, ela deve existir como `NNN_arquivo.sql` novo.

O runner falha sem alterar nada se existir sobreposição de agenda que a migração de
agendamento rejeitar (transação atômica); resolva os conflitos e reaplique. Evite volume
de dados reais nesta versão.

A atestação de uma evolução agora exige `expectedVersion` na API. Correções posteriores são registradas como adendos separados e imutáveis. Sem identidade profissional validada e assinatura digital regulatória, isso permanece uma atestação de desenvolvimento.

## Smoke test de integração (somente banco descartável)
Após iniciar API, web e banco de dados **sem dados reais**:

1. Garanta que `npm run migrate` aplicou todas as migrações (001–014+) e que `npm run bootstrap` criou o admin.
2. Configure `STARMED_TEST_DB=true` temporariamente no terminal e `STARMED_SMOKE_ADMIN_EMAIL` / `STARMED_SMOKE_ADMIN_PASSWORD` com a conta admin local (podem ser omitidas se as variáveis de bootstrap estiverem no .env).
3. Execute `npm run smoke` a partir da raiz. O script exige host de loopback e cria um médico, um paciente e atendimentos sintéticos. **Não há limpeza automática.**
4. Verifique saída e teste também o build com `npm run build` e a suíte unitária `npm test`.

O smoke valida, via HTTP, autenticação obrigatória, registro de alergias/problemas, salvamento idempotente, atestação e bloqueio pós-atestação, adendos idempotentes, leitura FHIR e prevenção de colisões na agenda.
**Ainda faltam:** autenticação entre múltiplos tenants, integrações de prescrição, testes automatizados de interface, concorrência real, backup/restore, pentest e conformidade clínica/regulatória. O script foi escrito para execução local, mas não foi executado neste ambiente.

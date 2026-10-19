# Runbook de Backup e Recuperação (DR) — StarMed

Runbook operacional do backup diário e do drill de recuperação. A política completa
(criptografia, retenção legal, incidentes) está em
`docs/regulatory/POLITICA_BACKUP_RECUPERACAO.md`.

## Agenda sugerida

| Item | Frequência | Ferramenta |
|---|---|---|
| Backup full (pg_dump -Fc) | Diário | `scripts/backup/pg-backup.mjs` |
| Retenção local | 7 dias (30 em produção com storage remoto) | flag `--retain N` |
| Drill de restore | Mensal (RTO) | `scripts/backup/restore-verify.mjs` |

- **RPO declarado:** ≤ 24h (backup full diário).
- **RTO declarado:** ≤ 2h (drill mensal mede o tempo real de restore).

## Como rodar o backup

```powershell
# Host com pg_dump no PATH:
node scripts/backup/pg-backup.mjs --url "$env:DATABASE_URL" --out backups --retain 7

# Sem pg_dump no host (Windows): via container Docker:
node scripts/backup/pg-backup.mjs --url 'postgres://user:pass@host:5433/starmed' `
  --docker ehr-platform-db-1 --out backups --retain 7
```

Saída: `starmed-backup-<UTC>.dump` (formato custom -Fc, sem owner/privileges),
sidecar `.sha256` e `manifest-latest.json` (URL redigida, bytes, sha256, executor).
A senha **nunca** aparece em log ou manifesto.

## Como rodar o drill de restore

```powershell
# Via container (socket interno, sem credenciais no comando):
node scripts/backup/restore-verify.mjs --dump backups\starmed-backup-....dump --docker ehr-platform-db-1

# Host com psql/pg_restore:
node scripts/backup/restore-verify.mjs --dump backups\starmed-backup-....dump --url "$env:DATABASE_URL"
```

O drill: cria `starmed_restore_verify` → restaura o dump → roda queries smoke
(`count(organizations)`, `to_regclass('clinical_notes')`, `to_regclass('audit_events')`)
→ remove o banco temporário mesmo em falha. Exit 0 = PASSOU.

## Critérios de aceite

- Restauração completa sem erro (exit 0 do pg_restore dentro do drill).
- Queries smoke retornam valores esperados (organizações > 0; tabelas core presentes).
- Tamanho do dump dentro de ±20% do anterior (drift maior indica mudança estrutural).
- Tempo de restore registrado no histórico abaixo (alerta se > 30 min).

## Histórico de drills

| Data | Executor | Dump | Resultado |
|---|---|---|---|
| 2026-10-19 | docker ehr-platform-db-1 (PG 16.15) | 57.161 bytes, sha256 510d7cd9… | **PASSOU** — organizations=1, clinical_notes/audit_events íntegros |

## Observações desta máquina

- `pg_dump`/`pg_restore` do **host** podem estar fora do PATH no Windows; use a
  variante `--docker <container>` (o binário vive dentro da imagem PG16).
- O drill anterior legado (`scripts/dr/local-restore-drill.mjs`) cobre o caso de
  restauração em diretório alternativo; este runbook cobre o fluxo de backup→restore.
- Repouso criptografado: seguir `docs/regulatory/POLITICA_CRIPTOGRAFIA.md` no storage
  de destino (fora do escopo destes scripts, que rodam em ambiente de desenvolvimento).

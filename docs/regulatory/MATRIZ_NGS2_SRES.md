# Matriz NGS2 / SRES — RenoveJá Public Service

**Data-base:** 26/08/2026  
**Objetivo:** organizar evidências de segurança do SRES/telemedicina e evitar declaração genérica de conformidade sem prova.

> Este documento é uma **matriz de evidências**, não um certificado SBIS e não afirma certificação formal que não tenha sido obtida.

## Matriz de controles

| Família | Controle RenoveJá | Evidência principal | Estado |
|---|---|---|---|
| Identidade | conta nominal e autenticação | `AuthService`, `auth_tokens` | implementado |
| Segundo fator | MFA doctor/admin/sus em produção | `MfaConfig`, `appsettings.Production.json`, `MfaChallengeStore` | implementado; homologar SMTP/fluxo |
| Autorização | RBAC global + institucional | `PublicSectorPermissions`, memberships | implementado |
| Menor privilégio | permissões granulares e deny por ausência | camada Public Sector | implementado |
| Isolamento | filtros de autorização + policies RLS | `RlsWave1Migrations`, policies PostgreSQL | policies implementadas; ativação do ambiente deve ser comprovada |
| Auditoria | eventos de acesso/mutação | audit events / audit log | implementado |
| Integridade de auditoria | trilha append-only/receipts | triggers / evidence ledger | implementado |
| Criptografia em trânsito | HTTPS/TLS na borda | ALB/CloudFront/API | comprovar em ambiente |
| Criptografia em repouso | storage/banco/segredos | AWS/KMS + envelope PFX | implementado/configurável; comprovar ambiente |
| Assinatura clínica | PAdES/ICP-Brasil | `DigitalCertificateService`, OIDs ITI | implementado; validar PDF real no ITI |
| Cadeia de confiança | trust store ICP-Brasil | `IcpBrasilTrustStore`, script de raízes | deploy materializa; comprovar imagem executada |
| Carimbo de tempo | ACT SERPRO/RFC3161 | `SerproTsaClient` | suportado; ativação opcional/externa |
| Consentimento | aceite e registro auditável | consents / termos | implementado |
| Retenção clínica | proteção contra exclusão indevida | migrations/triggers | implementado |
| Backup/continuidade | infraestrutura AWS | Terraform/AWS Backup | **não declarar pronto até execução real**; HA/custo tratado separadamente |
| Segurança de sessão | token/refresh/invalidação | auth token repository/cache | implementado |
| Rate limiting | políticas por endpoint | API rate limiting | implementado |
| Segurança de IA | revisão humana + minimização | `PrescriptionReviewGate`, `PromptSanitizer` | implementado |
| Interoperabilidade | adapters/API segura | Public Sector adapters | parcial conforme credenciais/homologação externa |
| Disponibilidade | meta contratual | contract profile/SLA | meta configurável; evidência operacional deve ser medida |

## Portão de produção

Uma linha só pode ser apresentada a contratante como “comprovada” quando houver **evidência do ambiente executado**, não apenas código versionado.

Exemplos:

- RLS: `ENABLE/FORCE` observado no PostgreSQL alvo;
- TLS: scanner/handshake do endpoint público;
- ICP-Brasil: PDF gerado pelo ambiente e relatório do Validar ITI;
- backup: restore executado e medido;
- MFA: login institucional `sus` concluído com desafio real;
- SLA: monitoramento do período, não percentual escrito em configuração.

## Evidências a arquivar por release

- SHA/versão implantada;
- resultado de build/testes;
- resultado dos integration tests PostgreSQL;
- inventário de configurações não secretas;
- relatório de dependências/vulnerabilidades;
- teste de MFA;
- resultado de RLS cross-tenant;
- PDF assinado + relatório ITI;
- teste de restauração quando aplicável;
- evidência de health checks/uptime;
- resultado de homologações RNDS/e-SUS/SNCR quando aplicáveis.

## Regra de redação em edital/diligência

Use “atende ao requisito por meio de [controle] e a evidência está em [artefato]”.

Não use “100% NGS2/SBIS” sem base de certificação/evidência correspondente.

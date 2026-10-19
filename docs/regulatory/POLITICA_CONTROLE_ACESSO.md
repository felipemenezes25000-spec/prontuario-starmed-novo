# Política de Controle de Acesso — RenoveJá+ / Public Service

**Versão:** 1.1  
**Data-base:** 26/08/2026  
**Classificação:** Documento Formal / baseline técnica  

## 1. Objetivo

Garantir que cada usuário acesse apenas as funções e dados necessários à sua finalidade, com autenticação, menor privilégio, segregação por instituição/unidade e rastreabilidade.

## 2. Princípios

- deny-by-default;
- menor privilégio;
- necessidade de saber;
- segregação de funções;
- escopo institucional explícito;
- autenticação reforçada para perfis sensíveis;
- auditoria de leitura/mutação nos fluxos cobertos;
- segunda camada de isolamento no banco quando RLS estiver efetivamente ativada no ambiente.

## 3. Identidades globais

| Role global | Uso |
|---|---|
| `patient` | cidadão/paciente |
| `doctor` | médico aprovado |
| `admin` | administração da plataforma |
| `sus` | usuário institucional do Public Service |

A role `sus` não define sozinha o poder do usuário. O papel operacional real é dado por `institution_memberships` e permissões institucionais.

## 4. Papéis institucionais

Perfis previstos no Public Service incluem:

- `municipal_manager`;
- `contract_manager`;
- `regulator`;
- `auditor`;
- `support`;
- `clinician`.

O escopo é por instituição e, quando aplicável, por unidade de saúde.

Permissões granulares incluem famílias como:

- `institution.*`;
- `contract.*`;
- `appointment.*`;
- `clinical.read` / `clinical.write` / `clinical.disclose`;
- `report.*`;
- `audit.*`;
- `billing.*`;
- `integration.*`.

`clinical.disclose` deve permanecer distinta de simples leitura clínica, pois autoriza superfícies identificáveis de maior risco, inclusive fiscalização externa quando aplicável.

## 5. Autenticação

### 5.1 Sessão

A API usa token opaco revogável persistido no backend, com refresh token separado. Não descrever esse mecanismo como JWT quando ele não for JWT.

### 5.2 Senha

Regras de complexidade são aplicadas pelos validators da aplicação e a senha é armazenada com BCrypt.

### 5.3 MFA

Em produção, MFA por código de uso único via e-mail é obrigatório para:

- `doctor`;
- `admin`;
- `sus`.

Assim, gestores, reguladores, auditores, suporte e clínicos institucionais não escapam do segundo fator por terem papel fino diferente dentro da instituição.

O paciente não possui MFA obrigatório por padrão.

Dependência operacional: SMTP precisa estar funcional. Conta protegida deve falhar fechada se o segundo fator não puder ser concluído.

## 6. Autorização de API

- `FallbackPolicy` exige autenticação para endpoint que não declare acesso público;
- `[AllowAnonymous]` é exceção explícita;
- médicos passam por controles de aprovação profissional;
- endpoints públicos institucionais usam `IPublicSectorAccessService` para resolver permissão e escopo;
- `patient` nunca deve ganhar acesso a dado de terceiro por ID fornecido pelo cliente;
- `sus` nunca deve ganhar acesso a outra instituição/unidade só por conhecer o GUID.

## 7. Paciente crônico / presencialidade

O endpoint que registra evidência de atendimento presencial é restrito a `sus,admin` e exige `clinical.write` no escopo da unidade.

O paciente não pode autoafirmar `is_presential=true`.

Essa evidência alimenta o gate de continuidade de 180 dias para renovação remota de paciente crônico.

## 8. RLS PostgreSQL

### Estado do código

- policies RLS versionadas;
- funções de contexto/segurança versionadas;
- `renoveja.user_id` propagado pelo caminho de conexão;
- preflight de papel da aplicação;
- script transacional de `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`;
- testes de integração;
- workflow manual `.github/workflows/activate-rls-wave1.yml`.

### Estado do ambiente

**Não presumir ativo.** A existência de policies não prova enforcement.

Antes de declarar RLS operacional:

1. confirmar app role sem `SUPERUSER`/`BYPASSRLS`;
2. confirmar role de manutenção separada;
3. confirmar contexto runtime;
4. executar preflight;
5. executar workflow/SQL autorizado;
6. comprovar `relrowsecurity` e `relforcerowsecurity`;
7. executar teste negativo cross-tenant pela aplicação.

## 9. Auditoria

Ações críticas devem produzir trilha suficiente para reconstruir:

- ator;
- entidade;
- horário;
- instituição/unidade quando aplicável;
- finalidade/canal;
- correlação;
- resultado da ação.

Superfícies de reidentificação e `clinical.disclose` devem ter auditoria reforçada.

## 10. Infraestrutura e administração

Acesso técnico a produção deve usar identidade individual, MFA e menor privilégio no provedor de infraestrutura. Segredos não devem ser colocados no repositório ou em documentação operacional.

## 11. Revisão

Revisar esta política quando houver:

- nova role global;
- novo papel/permissão institucional;
- nova superfície de controle externo;
- alteração de MFA;
- ativação/expansão de RLS;
- nova integração que altere escopo de dados;
- incidente de autorização.

## 12. Evidências relacionadas

- `../public-sector/MFA-DEPLOYMENT.md`
- `../security/ROW_LEVEL_SECURITY.md`
- `MATRIZ_NGS2_SRES.md`
- `RIPD_RENOVEJA.md`
- `ROPA_LGPD_RENOVEJA.md`
- `../public-sector/GO_LIVE_PUBLIC_SERVICE.md`

**Regra:** papel autenticado não substitui escopo autorizado; código versionado não substitui evidência do ambiente.

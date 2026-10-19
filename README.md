# StarMed — Prontuário Eletrônico

Projeto original de EHR/EMR, baseado em padrões abertos e necessidades clínicas, sem reutilização de código ou interfaces proprietárias.

## Escopo

Monorepo React + TypeScript (frontend) e NestJS + PostgreSQL (API), com formulários por especialidade, pacientes, atendimentos, documentos clínicos versionados, trilhas de auditoria, autenticação e interoperabilidade FHIR R4 inicial.

> **Atenção:** software em desenvolvimento, não apto a receber dados reais de pacientes ou a operar clinicamente até que controles de segurança, testes, processos, conformidade regulatória, homologação e validação clínica estejam concluídos.

## Componentes

- `apps/web`: interface clínica e editor de prontuário dinâmico.
- `apps/api`: API NestJS e persistência SQL.
- `database/schema.sql`: esquema PostgreSQL.
- `docs/architecture.md`: arquitetura, limitações e roadmap.
- `prompts/clinical-extraction.md`: extração clínica assistida por IA com revisão humana.

A implementação será adicionada a este repositório.
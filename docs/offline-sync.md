# Sincronização offline (rascunhos)

1. Médico autenticado habilita explicitamente o modo offline em dispositivo gerenciado e define frase-senha forte; derivar AES-256-GCM via PBKDF2 salt aleatório. Não persistir senha/chave em armazenamento do navegador.
2. Cada operação tem UUID idempotente, encounterId, expectedVersion, payload de rascunho serializado (somente cifrado no IndexedDB via Dexie). Minimizar metadados em claro, nunca cachear GET do prontuário.
3. Quando houver sessão válida, HTTPS e dispositivo desbloqueado, enviar FIFO para PUT /encounters/:id/notes/draft com operationId e expectedVersion; remover somente após resposta de sucesso.
4. Timeout/rede: reenvio seguro com mesma operationId; idempotency_keys impede execução duplicada.
5. Resposta 409: colocar na fila de conflito, **não** sobrescrever evolução de colega; exigir revisão humana e novo salvamento com versão recente.
6. Logout, perda do dispositivo, revogação e retenção: gestão corporativa precisa wipe remoto, política de armazenamento e tempo limite. Este MVP não possui wipe remoto; não habilitar para PHI real.
7. Assinatura e prescrição ficam sempre online; rascunhos conflitantes nunca são assinados automaticamente.

Segurança: IndexedDB, mesmo com cifra, ainda expõe metadados e depende de proteções do endpoint (XSS, malware, dispositivo). Service Worker tem somente cache de assets estáticos; não armazena respostas da API. O frontend demonstra fila local, não promete sincronização em background quando fechado.

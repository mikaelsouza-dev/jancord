# Jancord — regras pra quem mexe no código

Leia `PROJETO.md` antes de mudar o app.

## Commits

Toda tarefa terminada: **commit + push em `origin/main`**. Não entregar só arquivo local.

```bash
git add -A
git commit -m "o que mudou"
git push origin main
```

Não commitar `node_modules/`, `dist/`, logs, `.userdata/`.

Release pro usuário final: bump em `package.json` + tag `vX.Y.Z` + push da tag. Detalhes em `PROJETO.md`.

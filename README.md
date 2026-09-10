# Jancord

App de desktop pra **ligar** e **telar** com um amigo. Sem conta, sem Discord.

Voz e tela vão **direto de PC pra PC**. Hamachi/Radmin **não é obrigatório** — só se a ligação não nascer (rede muito fechada). Aí cola o IP virtual no campo “IP do amigo”.

## Baixar (pra usar de verdade)

Link sempre da última versão:

**https://github.com/mikaelsouza-dev/jancord/releases/latest**

1. Baixa `Jancord-Setup-x.x.x.exe`
2. Instala (Windows pode avisar “Windows protegeu o PC” — é porque o app ainda não tem certificado pago. *Mais informações* → *Executar assim mesmo*)
3. Abre o **Jancord** no menu Iniciar

Quando sair versão nova, o app **baixa sozinho** e mostra “Reiniciar e atualizar”.

Manda esse mesmo link pro amigo. Não precisa Node, Git, nem VS Code.

## Como usar

1. Cada um põe **só um nome**.
2. Um clica **Abrir rede** e manda o **convite**.
3. O outro cola o convite e clica **Conectar**.
4. **Ligar** e/ou **Telar**. Em Telar, deixa **Incluir som do PC**.

O Windows manda o áudio do PC inteiro, não só de uma janela. Usa fone pra não ter eco.

## Publicar update (você)

1. Sobe a versão no `package.json` (`1.0.0` → `1.0.1`).
2. Commit + tag com o **mesmo número**:

```bash
git add -A
git commit -m "Release v1.0.1"
git tag v1.0.1
git push origin main --tags
```

3. O GitHub Actions gera o instalador e publica em [Releases](https://github.com/mikaelsouza-dev/jancord/releases).
4. Os apps já instalados pegam sozinhos.

## Dev

```bash
npm install
npm start
```

Dois clientes no mesmo PC: `npm start` e `npm run second`.

Gerar instalador local (sem publicar): `npm run dist` → pasta `dist/`.

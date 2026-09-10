# Jancord — como o projeto funciona

App Electron 1:1 pra **ligar** e **telar** (com som do PC). Sem login, sem Discord, sem servidor de mídia.

Repo: https://github.com/mikaelsouza-dev/jancord  
Download: https://github.com/mikaelsouza-dev/jancord/releases/latest

---

## Sempre commit e push

A partir de agora, **toda mudança que ficar pronta vai pro GitHub**. Não deixar só na máquina.

No fim de uma tarefa:

```bash
git add -A
git commit -m "mensagem clara do que mudou"
git push origin main
```

- Não commitar `node_modules/`, `dist/`, `.userdata/`, logs.
- Se a mudança for **versão nova pro amigo baixar**, não basta push no `main`: tem que subir o número em `package.json` **e** criar tag `vX.Y.Z` (veja [Release](#release-pro-amigo)).

---

## O que o app faz

Dois PCs, sem conta:

1. Cada um põe um **nome**.
2. Um clica **Abrir rede** e manda o **convite** (`JANCORD/1/...`).
3. O outro cola e clica **Conectar**.
4. **Ligar** (voz) e/ou **Telar** (tela + som do PC).

Hamachi/Radmin **não é obrigatório**. Só se a ligação não nascer (rede muito fechada): os dois ligam a VPN e colam o IP virtual no campo “IP do amigo”.

Voz e tela vão **direto de PC pra PC** (WebRTC). O convite só serve pra os dois se acharem.

No Windows, o som da tela é o **áudio do computador inteiro**, não o de uma janela só. Usa fone pra não ter eco.

---

## Qual arquivo baixar no GitHub

Na página do Release aparecem **vários** arquivos. Só um instala:

| Arquivo | O que é | Abre? |
|---|---|---|
| **`Jancord-Setup-1.0.0.exe`** | Instalador | **Sim. É esse.** |
| `Jancord-Setup-1.0.0.exe.blockmap` | Mapa de blocos pro auto-update | **Não.** Não é o app. |
| `latest.yml` | Lista da versão pro app checar update | **Não.** |

O `.blockmap` o electron-builder **precisa** publicar pra atualização diferencial. Não apaga. Só **não baixa ele**.

Clica no arquivo que **termina em `.exe`**, sem `.blockmap` no nome.

Windows pode avisar “Windows protegeu o PC” (app sem certificado pago): *Mais informações* → *Executar assim mesmo*.

---

## Como a conexão funciona

1. **Convite / nome + chave** — os dois entram na mesma “rede”.
2. **Sinal** (só o “oi”, SDP/ICE): IP direto na porta `34780`, ou broker MQTT público com payload criptografado pela chave.
3. **Mídia** (voz + tela): WebRTC ponto a ponto. Não passa pelo GitHub nem pelo MQTT.

Arquivos principais:

- `electron/main.js` — janela, captura de tela, auto-update
- `electron/network.js` — convite, WebSocket, MQTT
- `electron/preload.js` — ponte segura pro renderer
- `src/` — UI, WebRTC (`rtc.js`), tela e microfone
- `.github/workflows/release.yml` — build do `.exe` e publish

---

## Dev (esta máquina)

```bash
npm install
npm start
```

Segundo cliente no mesmo PC: `npm run second`.

---

## Release pro amigo

O amigo **não** usa `npm start`. Ele instala o `.exe` do Releases.

1. Sobe `version` no `package.json` (`1.0.0` → `1.0.1`).
2. Commit + tag **igual** à versão:

```bash
git add -A
git commit -m "Release v1.0.1"
git tag v1.0.1
git push origin main --tags
```

3. GitHub Actions (workflow **Release**) gera o instalador e publica.
4. Apps já instalados baixam sozinhos e mostram “Reiniciar e atualizar”.

Repo precisa ser **público** senão o amigo não baixa e o auto-update não funciona.

---

## Pasta que não vai pro git

`node_modules/`, `dist/`, `.userdata/`, `*.log`, `.electron-err.txt`, `.electron-out.txt`.

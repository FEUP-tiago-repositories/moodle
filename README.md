# Moodle GitHub Actions watcher

Automação em TypeScript com Playwright para correr no GitHub Actions e verificar, de 10 em 10 minutos, se o estudante já submeteu `questions.pdf` numa atividade Moodle. Quando o ficheiro aparece, o workflow descarrega-o e envia-o por email.

## O que faz

- Abre a página da atividade Moodle;
- Se a sessão existir e estiver válida, reutiliza-a;
- Se a sessão tiver expirado, tenta login automático com `UP_USERNAME` e `UP_PASSWORD` guardados em GitHub Secrets;
- Procura `questions.pdf` na zona de submissão/"Ficheiros";
- Descarrega o ficheiro;
- Calcula hash SHA-256 para evitar reenvio do mesmo ficheiro;
- Envia o PDF por email;
- Guarda `profile/` e `state.json` em cache e em artifact com retenção de 1 dia.

## Secrets a criar no repositório

Vai a **Settings > Secrets and variables > Actions** e cria estes secrets:

### Moodle
- `LOGIN_URL`
- `ASSIGNMENT_URL`
- `EXPECTED_FILENAME` (valor: `questions.pdf`)
- `UP_USERNAME`
- `UP_PASSWORD`

### Email
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE` (`true` ou `false`)
- `SMTP_USER`
- `SMTP_PASS`
- `EMAIL_FROM`
- `EMAIL_TO`
- `EMAIL_SUBJECT`

## Como usar

1. Configurar todos os secrets.
2. Ir a **Actions** e correr o workflow manualmente uma vez com **Run workflow**.
3. Depois disso o workflow corre automaticamente de 10 em 10 minutos.

## Notas

- O artifact tem retenção de 1 dia, alinhado com a janela máxima de 24h.
- Se o IdP tiver MFA/captcha, a automação pode deixar de conseguir autenticar-se sozinha.
- O script procura o nome exato `questions.pdf` na zona de submissão.

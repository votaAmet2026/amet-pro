# AMET - Control de Votación con Telegram

Sistema listo para usar en PC o servidor, con:
- padrón AMET ya cargado desde el Excel real que subiste
- búsqueda por DNI, apellido o nombre
- estado rojo/verde
- actualización en tiempo real entre dispositivos
- exportación final a Excel
- aviso automático al grupo de Telegram al marcar "votó"

## Qué trae ya preparado
- `data/padron_amet_seed.json`: padrón base convertido desde tu archivo Excel
- `server.js`: backend + tiempo real + Telegram
- `public/`: interfaz web responsive para celular y PC
- `data/votacion.sqlite`: se crea solo al iniciar

## Antes de usar
1. Instalá Node.js 20 o superior.
2. Abrí esta carpeta en la PC.
3. Copiá `.env.example` como `.env`.
4. En `.env` completá:
   - `TELEGRAM_BOT_TOKEN=` tu token actual del bot
   - `TELEGRAM_CHAT_ID=` el ID del grupo

## Inicio rápido
```bash
npm install
npm start
```

Después abrí:
```text
http://localhost:3000
```

## Uso
- `Cargar padrón AMET`: vuelve a cargar el padrón base incluido.
- `Reemplazar con otro Excel`: importa otro archivo.
- `Marcar votó`: cambia a verde y envía mensaje a Telegram.
- `Desmarcar`: vuelve a pendiente.
- `Exportar Excel`: baja el archivo actualizado.
- `Reiniciar marcas`: deja todo en pendiente otra vez.

## Importación Excel
Si el Excel tiene hoja `BASE`, la usa primero.
Si no, usa la primera hoja y busca estas columnas:
- `DNI`
- `Apellido y Nombre` o `Apellido y nombre`
- `Escuela`
- `Mesa`
- `Hoja`
- `N° en padrón`
- `Fila en hoja`

## Multiusuario
Todos los dispositivos abiertos contra el mismo servidor ven los cambios en vivo.
Si querés usarlo desde varios celulares, todos deben entrar a la misma IP o dominio donde corra este servidor.
Ejemplo en red local:
```text
http://192.168.0.25:3000
```

## Telegram
El grupo debe tener al bot como administrador.
Para evitar ruido, en Telegram dejá que escriban solo admins y el bot.

## Importante
Como el token se compartió durante la configuración, conviene conservar solo el token más reciente y no volver a publicarlo.

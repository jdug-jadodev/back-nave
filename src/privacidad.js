/**
 * Política de privacidad de Astrion Space, en español (/privacidad) y en inglés (/privacy).
 *
 * La piden Google Play, AdMob y la pantalla de consentimiento de Google, y tiene que estar en una
 * dirección pública. Lo que dice sale de lo que el juego y este servidor hacen de verdad: si eso
 * cambia (un dato nuevo, otro proveedor, otros plazos), hay que cambiar este texto y su fecha.
 * Los plazos se toman de reglas.js para que no se desfasen.
 */
export const CONTACT = 'astrionspace.game@gmail.com';
export const UPDATED = { es: '23 de noviembre de 2026', en: 'November 23, 2026' };

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const mail = `<a href="mailto:${CONTACT}">${CONTACT}</a>`;
const GOOGLE_ADS = 'https://policies.google.com/technologies/partner-sites';
const GOOGLE_PRIVACY = 'https://policies.google.com/privacy';
const CLOUDFLARE_PRIVACY = 'https://www.cloudflare.com/privacypolicy/';

/* keep = { weeks, duelDays, visitDays }: cuánto se conserva cada cosa (reglas.js) */
const TEXT = {
  es: (keep) => ({
    title: 'Política de privacidad de Astrion Space',
    other: '<a href="/privacy">English</a>',
    updated: 'Última actualización: ' + UPDATED.es,
    body: `
<p>Astrion Space es un juego para Android hecho por IANEJ. Esta página explica qué datos usa el juego, para qué y cómo puedes borrarlos. Si tienes una pregunta, escríbenos a ${mail}.</p>

<h2>En pocas palabras</h2>
<ul>
<li>Puedes jugar sin crear una cuenta y sin dar tu nombre ni tu correo.</li>
<li>No guardamos tu correo, tu nombre, tu foto ni ninguna contraseña.</li>
<li>No vendemos tus datos.</li>
<li>El juego muestra anuncios de Google (AdMob), y Google usa algunos datos de tu teléfono para eso.</li>
</ul>

<h2>Qué datos usa el juego</h2>
<h3>Si juegas sin cuenta</h3>
<ul>
<li><b>Un identificador al azar de la instalación.</b> Lo crea el juego la primera vez que se abre. No dice quién eres ni sale de tu teléfono o de tu cuenta de Google; sirve para distinguir una instalación de otra.</li>
<li><b>El apodo que escribes</b> y <b>tus tiempos</b> en la copa semanal y en los retos entre amigos. El apodo y el tiempo se muestran a los demás jugadores en la tabla.</li>
<li><b>Los días en que abriste el juego</b>, junto al identificador de la instalación, para saber cuánta gente juega y cuánta vuelve.</li>
<li><b>Tu dirección IP</b>, solo un momento, para frenar a quien abusa del servidor. Queda en contadores que se borran en un día como máximo.</li>
</ul>
<h3>Si guardas tu progreso con Google (opcional)</h3>
<ul>
<li>Para entrar usas tu cuenta de Google. Google nos confirma quién eres, pero <b>no guardamos tu correo, tu nombre ni tu foto</b>: solo una huella cifrada del número de tu cuenta, que no se puede convertir de vuelta en tu cuenta.</li>
<li>Guardamos <b>tu progreso en el juego</b>: monedas, piezas de la nave, récords, ajustes, apodo e identificador de la instalación.</li>
<li>Con cada guardado revisamos que el progreso sea posible jugando o comprando, para dejar fuera de la copa a quien hace trampa.</li>
</ul>
<h3>Si compras algo</h3>
<ul>
<li>El pago lo hace <b>Google Play</b>. Nosotros nunca vemos tu tarjeta ni tus datos de pago.</li>
<li>Guardamos una huella del comprobante, qué producto fue, el número de orden de Google, la fecha y una huella del identificador de la instalación, para entregarte lo comprado una sola vez y poder devolvértelo si reinstalas.</li>
</ul>
<h3>Anuncios</h3>
<ul>
<li>El juego muestra anuncios con <b>Google AdMob</b>. Para eso, Google recoge desde tu teléfono datos como el identificador de publicidad, la dirección IP, el modelo y sistema del teléfono, y cómo interactúas con los anuncios. Esos datos van a Google, no a nosotros.</li>
<li>Google explica cómo los usa en <a href="${GOOGLE_ADS}">${GOOGLE_ADS}</a>.</li>
<li>Puedes borrar o restablecer tu identificador de publicidad en los ajustes de Android (Privacidad → Anuncios). Si vives donde la ley lo exige, el juego te pregunta antes de mostrar anuncios personalizados y puedes cambiar tu respuesta en Configuración → Anuncios.</li>
</ul>
<h3>Lo que se queda en tu teléfono</h3>
<ul>
<li>Tu progreso se guarda en el teléfono. El recordatorio diario, si lo enciendes, lo hace el propio teléfono: no nos avisa de nada.</li>
<li>El juego no pide tu ubicación, tus contactos, tu cámara, tu micrófono ni tus archivos.</li>
</ul>

<h2>Para qué se usan</h2>
<p>Para que el juego funcione: mostrar la copa semanal y los retos, guardar y recuperar tu progreso, entregar tus compras, evitar trampas y abusos, saber cuánta gente juega y mostrar anuncios.</p>

<h2>Con quién se comparten</h2>
<ul>
<li><b>Google</b>: inicio de sesión, pagos de Google Play y anuncios de AdMob (<a href="${GOOGLE_PRIVACY}">su política</a>).</li>
<li><b>Cloudflare</b>: es donde está alojado el servidor del juego (<a href="${CLOUDFLARE_PRIVACY}">su política</a>).</li>
</ul>
<p>No vendemos ni entregamos tus datos a nadie más, salvo que una autoridad lo exija por ley.</p>

<h2>Cuánto tiempo se guardan</h2>
<ul>
<li>Los tiempos de la copa: ${keep.weeks} semanas.</li>
<li>Los retos entre amigos: hasta ${keep.duelDays} días después de su última partida.</li>
<li>Los días en que abriste el juego: ${keep.visitDays} días.</li>
<li>Tu cuenta y tu progreso guardado: hasta que los borres.</li>
<li>El registro de compras: mientras exista el juego, porque es la prueba de lo que compraste.</li>
</ul>

<h2>Cómo borrar tus datos</h2>
<ul>
<li><b>Tu cuenta y tu progreso guardado:</b> en el juego, entra a Configuración → Tu progreso → «Borrar mi cuenta y lo guardado». Se borran al instante.</li>
<li><b>Sin abrir el juego, o cualquier otro dato</b> (tu apodo y tus tiempos, por ejemplo): escríbenos a ${mail} y lo borramos. Te diremos cómo indicarnos cuál es tu instalación.</li>
<li><b>Lo que hay en tu teléfono:</b> se borra al desinstalar el juego o al borrar sus datos en los ajustes de Android.</li>
</ul>
<p>También puedes escribirnos para saber qué datos tuyos tenemos o para corregirlos.</p>

<h2>Menores de edad</h2>
<p>Astrion Space no está dirigido a menores de 13 años y no recogemos a sabiendas datos de ellos. Si crees que un menor nos dio datos, escríbenos y los borramos.</p>

<h2>Seguridad</h2>
<p>Todo viaja cifrado (HTTPS). No manejamos contraseñas, y de tu cuenta de Google y de tus compras solo guardamos huellas que no sirven para identificarte.</p>

<h2>Cambios</h2>
<p>Si esta política cambia, publicaremos aquí la nueva versión con su fecha.</p>`,
  }),
  en: (keep) => ({
    title: 'Astrion Space Privacy Policy',
    other: '<a href="/privacidad">Español</a>',
    updated: 'Last updated: ' + UPDATED.en,
    body: `
<p>Astrion Space is an Android game made by IANEJ. This page explains what data the game uses, what for, and how you can delete it. If you have a question, write to ${mail}.</p>

<h2>In short</h2>
<ul>
<li>You can play without creating an account and without giving your name or email.</li>
<li>We do not store your email, your name, your photo or any password.</li>
<li>We do not sell your data.</li>
<li>The game shows ads from Google (AdMob), and Google uses some data from your phone for that.</li>
</ul>

<h2>What data the game uses</h2>
<h3>If you play without an account</h3>
<ul>
<li><b>A random installation identifier.</b> The game creates it the first time it opens. It does not say who you are and does not come from your phone or your Google account; it only tells one installation from another.</li>
<li><b>The nickname you type</b> and <b>your times</b> in the weekly cup and in challenges between friends. The nickname and the time are shown to other players on the leaderboard.</li>
<li><b>The days you opened the game</b>, next to the installation identifier, to know how many people play and how many come back.</li>
<li><b>Your IP address</b>, only briefly, to stop anyone abusing the server. It stays in counters that are deleted within a day at most.</li>
</ul>
<h3>If you save your progress with Google (optional)</h3>
<ul>
<li>You sign in with your Google account. Google confirms who you are, but <b>we do not store your email, your name or your photo</b>: only an encrypted fingerprint of your account number, which cannot be turned back into your account.</li>
<li>We store <b>your game progress</b>: coins, ship parts, records, settings, nickname and installation identifier.</li>
<li>With each save we check that the progress is possible by playing or buying, to keep cheaters out of the cup.</li>
</ul>
<h3>If you buy something</h3>
<ul>
<li>The payment is handled by <b>Google Play</b>. We never see your card or your payment details.</li>
<li>We store a fingerprint of the receipt, which product it was, Google's order number, the date and a fingerprint of the installation identifier, to deliver your purchase only once and to give it back if you reinstall.</li>
</ul>
<h3>Ads</h3>
<ul>
<li>The game shows ads with <b>Google AdMob</b>. For that, Google collects data from your phone such as the advertising ID, the IP address, the phone model and system, and how you interact with ads. That data goes to Google, not to us.</li>
<li>Google explains how it uses it at <a href="${GOOGLE_ADS}">${GOOGLE_ADS}</a>.</li>
<li>You can delete or reset your advertising ID in Android settings (Privacy → Ads). If you live where the law requires it, the game asks you before showing personalized ads and you can change your answer in Settings → Ads.</li>
</ul>
<h3>What stays on your phone</h3>
<ul>
<li>Your progress is saved on the phone. The daily reminder, if you turn it on, is done by the phone itself: it tells us nothing.</li>
<li>The game does not ask for your location, contacts, camera, microphone or files.</li>
</ul>

<h2>What it is used for</h2>
<p>To make the game work: showing the weekly cup and challenges, saving and restoring your progress, delivering your purchases, preventing cheating and abuse, knowing how many people play, and showing ads.</p>

<h2>Who it is shared with</h2>
<ul>
<li><b>Google</b>: sign-in, Google Play payments and AdMob ads (<a href="${GOOGLE_PRIVACY}">their policy</a>).</li>
<li><b>Cloudflare</b>: where the game server is hosted (<a href="${CLOUDFLARE_PRIVACY}">their policy</a>).</li>
</ul>
<p>We do not sell or hand over your data to anyone else, unless an authority requires it by law.</p>

<h2>How long it is kept</h2>
<ul>
<li>Cup times: ${keep.weeks} weeks.</li>
<li>Challenges between friends: up to ${keep.duelDays} days after their last run.</li>
<li>The days you opened the game: ${keep.visitDays} days.</li>
<li>Your account and saved progress: until you delete them.</li>
<li>The purchase record: for as long as the game exists, because it is the proof of what you bought.</li>
</ul>

<h2>How to delete your data</h2>
<ul>
<li><b>Your account and saved progress:</b> in the game, go to Settings → Your progress → “Delete my account and saved data”. They are deleted right away.</li>
<li><b>Without opening the game, or any other data</b> (your nickname and times, for example): write to ${mail} and we will delete it. We will tell you how to point us to your installation.</li>
<li><b>What is on your phone:</b> it is deleted when you uninstall the game or clear its data in Android settings.</li>
</ul>
<p>You can also write to us to know what data of yours we have or to correct it.</p>

<h2>Children</h2>
<p>Astrion Space is not directed to children under 13 and we do not knowingly collect data from them. If you believe a child gave us data, write to us and we will delete it.</p>

<h2>Security</h2>
<p>Everything travels encrypted (HTTPS). We handle no passwords, and from your Google account and your purchases we only keep fingerprints that cannot identify you.</p>

<h2>Changes</h2>
<p>If this policy changes, we will publish the new version here with its date.</p>`,
  }),
};

/** La página completa. lang = 'es' o 'en'; keep = { weeks, duelDays, visitDays }. */
export function privacyPage(lang, keep) {
  const t = TEXT[lang === 'en' ? 'en' : 'es'](keep);
  return `<!doctype html><html lang="${lang === 'en' ? 'en' : 'es'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.title)}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#070b18;color:#dde6ff;margin:0;line-height:1.55}
main{max-width:720px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:24px;margin:0 0 4px;color:#fff}
h2{font-size:18px;margin:30px 0 6px;color:#5ee0ff}
h3{font-size:15px;margin:18px 0 4px;color:#ffb454}
p,li{font-size:15px}
ul{padding-left:20px;margin:6px 0}
li{margin:5px 0}
a{color:#5ee0ff}
.top{display:flex;justify-content:space-between;gap:12px;font-size:13px;color:#8fa0cc;margin-bottom:18px}
</style></head><body><main>
<h1>${esc(t.title)}</h1>
<div class="top"><span>${esc(t.updated)}</span><span>${t.other}</span></div>
${t.body}
</main></body></html>`;
}

/** La respuesta lista para servir. Se puede guardar en caché: es igual para todos. */
export function privacyResponse(lang, keep) {
  return new Response(privacyPage(lang, keep), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

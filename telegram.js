const cfg = require('./config');

async function sendTelegram(message) {
if (!cfg.tgToken || !cfg.tgAdmin) {
console.error('Telegram credentials are missing.');
return false;
}

const url = "https://api.telegram.org/bot${cfg.tgToken}/sendMessage";

// Telegram message limit is 4096 characters.
const chunks = [];
for (let i = 0; i < message.length; i += 3500) {
chunks.push(message.slice(i, i + 3500));
}

try {
for (const chunk of chunks) {
const response = await fetch(url, {
method: 'POST',
headers: {
'Content-Type': 'application/json'
},
body: JSON.stringify({
chat_id: cfg.tgAdmin,
text: chunk
})
});

  const result = await response.json();

  if (!result.ok) {
    console.error('Telegram API error:', result.description);
    return false;
  }
}

return true;

} catch (error) {
console.error('Telegram send error:', error.message);
return false;
}
}

module.exports = { sendTelegram };

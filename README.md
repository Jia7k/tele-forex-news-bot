# Telegram Forex News Bot 📰💱

![JavaScript](https://img.shields.io/badge/javascript-%23323330.svg?style=flat&logo=javascript&logoColor=%23F7DF1E)
![NodeJS](https://img.shields.io/badge/node.js-6DA55F?style=flat&logo=node.js&logoColor=white)

A Node.js Telegram bot that automatically scrapes economic news and events from Forex Factory and delivers them directly to your Telegram chat. Stay updated on market-moving events without having to constantly check the calendar!

## ✨ Features

* **Automated Web Scraping:** Pulls the latest economic calendar events directly from Forex Factory.
* **Instant Telegram Delivery:** Sends formatted news alerts directly to users via the Telegram Bot API.
* **Data Parsing:** Neatly structures complex financial calendar data into an easily readable Telegram message.
* **Automated Updates:** Keeps you informed of crucial economic events that could impact your trading strategy.

## 📂 Repository Structure

```text
tele-forex-news-bot/
├── data/               # Local storage for scraped data and configurations
├── src/                # Core bot logic, Telegram API integration, and scraping scripts
├── .gitignore          # Ignored files and directories
├── package.json        # Node.js project metadata and dependency lists
└── package-lock.json   # Exact dependency versions

## 🚀 Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/Jia7k/tele-forex-news-bot.git](https://github.com/Jia7k/tele-forex-news-bot.git)
   cd tele-forex-news-bot
   ```

2. **Install dependencies:**
   Ensure you have [Node.js](https://nodejs.org/) installed, then run:
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Create a `.env` file in the root directory and add your Telegram Bot Token (obtained from [@BotFather](https://t.me/botfather)):
   ```env
   TELEGRAM_BOT_TOKEN=your_bot_token_here
   ```

## 💻 Usage

To start the bot, run the following command in your terminal:

```bash
npm start
```
*(Note: If you haven't defined a start script, run the main file directly, e.g., `node src/index.js` or `node src/bot.js`)*

Once the script is running, open Telegram, find your bot, and start a chat to begin receiving Forex Factory news updates.

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! 
1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/NewScraper`)
3. Commit your Changes (`git commit -m 'Add a new scraping feature'`)
4. Push to the Branch (`git push origin feature/NewScraper`)
5. Open a Pull Request

## 📝 License

Distributed under the MIT License. See `LICENSE` for more information.

## 📬 Contact

**Jia7k** - [Email](jiarong112@gmail.com)


```

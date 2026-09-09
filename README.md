# Whatooz Remote Server Worker

Ce dépôt contient le moteur d'exécution distant pour déployer et gérer les instances de bots WhatsApp Whatooz sur des serveurs distants (VPS, Katabump, Pterodactyl).

## 🚀 Installation Rapide

`ash
# 1. Cloner le dépôt
git clone https://github.com/stephdev12/server-dist.git
cd server-dist

# 2. Installer les dépendances
npm install

# 3. Configurer l'environnement
cp .env.example .env
nano .env

# 4. Lancer le serveur
npm start
`

## ⚙️ Variables d'environnement (.env)

- CONVEX_URL : URL de votre backend Convex (ex: https://incredible-hummingbird-86.convex.cloud)
- MASTER_TOKEN : Jeton maître de communication
- SERVER_ID : Identifiant du serveur dans Whatooz (pour le mode multi-serveur)
- SERVER_TOKEN : Token secret assigné au serveur
- GEMINI_API_KEY : Clé API pour la détection d'intention IA
- PORT : Port d'écoute (défaut: 3001)

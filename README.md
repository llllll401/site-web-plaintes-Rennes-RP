# Rennes RP — hébergement Render

Site HTML statique servi par un serveur Node/Express, avec API, base PostgreSQL et pièces jointes sur disque persistant Render. Pas de build front-end.

## Déploiement

1. Dans Render, créez un **Blueprint** depuis ce dépôt et appliquez `render.yaml` (ou créez un Web Service Node et une base PostgreSQL selon les valeurs du fichier).
2. Dans les variables d’environnement du service web, définissez `STAFF_ACCESS_CODE` (au moins 16 caractères aléatoires). C’est un secret côté serveur; ne l’inscrivez jamais dans `index.html` ni dans Git.
3. Render génère `SESSION_SECRET` automatiquement. Le service utilise le disque persistant `/var/data` pour les preuves et PostgreSQL pour les dossiers.
4. Attendez que le déploiement et la base soient prêts. Le schéma SQL est initialisé automatiquement au démarrage.

Le Blueprint déclare un disque de 20 Go : modifiez `sizeGB` dans `render.yaml` selon votre besoin et votre forfait. Les fichiers audio/MP3, vidéo/MP4 et images peuvent être envoyés en plusieurs pièces sans limite logicielle de nombre ou de taille par fichier. **Il n’existe pas de capacité réellement illimitée** : le stockage disponible, le temps de transfert, les limites de l’offre et le coût du disque Render s’appliquent. Surveillez l’espace disque et augmentez-le avant saturation. Les disques persistants Render nécessitent une instance compatible payante.

## Fonctionnement et sécurité

- Sessions staff signées, cookie `HttpOnly`, `Secure` et `SameSite=Strict`, expiration après 8 heures et limitation des essais de code.
- La revendication est une mise à jour PostgreSQL atomique : un seul staff peut prendre un dossier. Le serveur refuse toute libération ou résolution par un autre membre.
- Les fichiers ne sont pas servis comme fichiers statiques. Leur téléchargement passe par une route staff authentifiée. « Marquer traité » supprime l’enregistrement et les fichiers du disque.
- Les pièces sont conservées sur le disque Render et la référence des dossiers dans PostgreSQL. Configurez les sauvegardes et une politique de conservation adaptée. Le traitement supprime les fichiers de l’application, pas les copies éventuellement présentes dans des sauvegardes.
- Les signalements peuvent contenir des données personnelles : limitez les accès au compte Render, informez les joueurs de la finalité et de la conservation, et respectez les obligations RGPD.

Pour démarrer localement : Node.js 20+, PostgreSQL, `npm install`, puis définir `DATABASE_URL`, `STAFF_ACCESS_CODE`, `SESSION_SECRET` (32 caractères minimum) et `UPLOAD_DIR`, et lancer `npm start`. Les cookies `Secure` supposent un accès HTTPS; utilisez un proxy HTTPS en production.

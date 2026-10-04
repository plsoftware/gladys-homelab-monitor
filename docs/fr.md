# Machines Linux (node_exporter) pour Gladys

Affiche les machines Linux de votre réseau dans Gladys — CPU, mémoire, disques,
températures, santé des disques, mises à jour et services en échec — avec des
jauges sur le tableau de bord et des alertes dans les scènes.

## Avant de commencer

Sur chaque machine (Debian, Ubuntu, Raspberry Pi OS, Proxmox VE) :

```
sudo apt install prometheus-node-exporter prometheus-node-exporter-collectors
```

Vérifiez qu'il répond : `http://<machine>:9100/metrics` dans un navigateur.

Les disques montés sous `/mnt` ou `/media` sont masqués par le paquet Debian/Ubuntu. Pour les afficher :

```
echo 'ARGS="--collector.filesystem.mount-points-exclude=^/(dev|proc|run|sys|var/lib/docker/.+|var/lib/containers/storage/.+)($|/)"' | sudo tee /etc/default/prometheus-node-exporter
sudo systemctl restart prometheus-node-exporter
```

## Configuration

1. **Machines** : `nom=adresse`, séparés par des virgules, ex. `serveur1=192.168.1.10, nas=192.168.1.11`.
2. Ajustez les seuils d'alerte si besoin (CPU 95 %, mémoire 90 %, disque 90 %, CPU 85 °C).
3. Ouvrez l'onglet Découverte et créez les appareils.
4. Ajoutez le widget **Machine Linux** (un par machine) ou la vue **Machines Linux** à un tableau de bord.

## Alertes

Créez une scène avec le déclencheur **Alerte machine Linux**, éventuellement filtré par
machine, type d'alerte et déclenchée/levée, et utilisez `{{triggerEvent.data.host_name}}`,
`{{triggerEvent.data.alert_label}}` et `{{triggerEvent.data.detail}}` dans le message.

## Dépannage

- *Aucune machine n'a répondu* — vérifiez l'adresse et que le port 9100 est joignable depuis la machine Gladys.
- Lectures mises à jour/redémarrage/disques absentes — installez `prometheus-node-exporter-collectors` ; ses minuteurs tournent toutes les 15 minutes.
- Journaux : `docker logs` sur le conteneur de l'intégration.

# AviationSpot360 Ground School

A scroll-driven 3D walk through the AviationSpot360 ground school: the campus at sunset, the reception
lobby, a live-radar screen in the lounge, and rooms A (Cadet Prep) and B (1-on-1 Mentorship).

Live: https://nikunj69420.github.io/aviationnew/ · Main site: https://nikunj69420.github.io/aviationspot/

Built with Three.js, GSAP ScrollTrigger and Lenis. The building and furniture are generated in code; the aircraft
and the tower are glTF models in `models/`.

## Model credits

- Airbus A320 by OUTPISTON (CC BY-NC-SA 4.0), AviationSpot360 livery added: https://sketchfab.com/outpiston
- Cessna 182 Skylane by VTX (CC BY-NC-SA 4.0): https://sketchfab.com/VTX_car
- Gulfstream G650ER by Luca Martina (CC BY 4.0): https://sketchfab.com/LucaMartina
- Delhi ATC tower: built for the AviationSpot360 site

## Live radar data

GitHub Pages only serves static files, so the lounge radar shows clearly labelled *simulated* traffic there.
For real ADS-B traffic (from adsb.lol) run the small local server, which proxies the feed:

    python dev_server.py        # then open http://localhost:5174/

This folder is generated from `coaching-centre/` in the aviationspot repo by `coaching-centre/publish.py`;
make changes there and re-publish.

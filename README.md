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
- Jet Engine (mentor's desk) by Pilot (CC BY 4.0): https://sketchfab.com/playerhack
- Residential Furniture by ATD-London (CC BY 4.0), pieces cut from it: https://sketchfab.com/ATD-London
- Bookshelf [CC0] by Crew Froebel (CC BY 4.0): https://sketchfab.com/crufro
- Delhi T3 pier: from "VIDP Indira Gandhi International Airport" (MSFS scenery) by AvinashC, converted to glTF and used with the author's permission: https://flightsim.to/addon/7681/vidp-indira-gandhi-international-airport
- Airline A320neo (FAIB, CFM) and Boeing 787-9 (AIG, Rolls-Royce) with their liveries: Alpha India Group AI aircraft, converted from MSFS and used with permission
- Sky, HDRI and surface textures: Poly Haven (CC0), https://polyhaven.com

## Engine simulator

`engine/cfm56.html` is a CFM56-5B4 turbofan built with the teardown kit (https://github.com/elvarofficial/teardown,
MIT; kit and review rules from whaleyxbt/claude-motion, MIT). Every limit and rating comes from EASA Type-Certificate
Data Sheet E.003, Issue 06 (9 January 2023); the power schedule between those limits is modelled and labelled so.

## Live radar data

GitHub Pages only serves static files, so the lounge radar shows clearly labelled *simulated* traffic there.
For real ADS-B traffic (from adsb.lol) run the small local server, which proxies the feed:

    python dev_server.py        # then open http://localhost:5174/

This folder is generated from `coaching-centre/` in the aviationspot repo by `coaching-centre/publish.py`;
make changes there and re-publish.

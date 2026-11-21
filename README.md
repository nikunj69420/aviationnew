# AviationSpot360 Ground School

A scroll-driven 3D walk through the AviationSpot360 ground school: the campus, the reception lobby, a live-radar
screen in the lounge, rooms A (Cadet Prep) and B (1-on-1 Mentorship), and Door C out to a fictional training
airfield in farmland: trainers flying circuits, airliners at a small terminal, hangars at work, a town astride an
expressway, a canal and a railway, day or dusk, with ride-along views of a trainer and the train.

Live: https://nikunj69420.github.io/aviationnew/ · Main site: https://nikunj69420.github.io/aviationspot/

Built with Three.js, GSAP ScrollTrigger and Lenis. The building and furniture are generated in code; the aircraft
and the tower are glTF models in `models/`.

## Model credits

- Airbus A320 by OUTPISTON (CC BY-NC-SA 4.0), AviationSpot360 livery added: https://sketchfab.com/outpiston
- Cessna 182 Skylane by VTX (CC BY-NC-SA 4.0): https://sketchfab.com/VTX_car
- Gulfstream G650ER by Luca Martina (CC BY 4.0): https://sketchfab.com/LucaMartina
- Hangars: "Hangar Embraer" by Simaoelis3D (CC BY 4.0): https://sketchfab.com/simaoelis3d
- Jet Engine (mentor's desk) by Pilot (CC BY 4.0): https://sketchfab.com/playerhack
- Residential Furniture by ATD-London (CC BY 4.0), pieces cut from it: https://sketchfab.com/ATD-London
- Bookshelf [CC0] by Crew Froebel (CC BY 4.0): https://sketchfab.com/crufro
- Airline A320neo (FAIB, CFM) and Boeing 787-9 (AIG, Rolls-Royce) with their liveries: Alpha India Group AI aircraft, converted from MSFS and used with permission
- Pushback tug: "GameAsset - Airport Pushback" by Loic ALIX (CC BY-NC 4.0): https://sketchfab.com/3d-models/gameasset-airport-pushback-b7fce88407db486fa9a082042424c15f
- Catering truck: "Airport Catering Truck" by spot1studios (CC BY 4.0): https://sketchfab.com/3d-models/airport-catering-truck-289f4e2cfa3f4722b0476b1fc37681d8
- Runway rubber deposits: tyre-gum texture from "BetterTaxiwayMarker and HeavySkidMark" (MSFS) by FlyerGaia, used with permission
- Plants: "Scanned Plants and Grass (Free Download)" by Kless (CC BY 4.0): https://sketchfab.com/3d-models/scanned-plants-and-grass-free-download-d0fbc8fecfbb40bf9029bc97b6e9e122
- Dry grass: "Simple grass chunks" by 3dhdscan (CC BY 4.0): https://sketchfab.com/3d-models/simple-grass-chunks-eb4f6dc9d4e3455ea3435385faf58b60
- Trees: "Maple tree" by atrodler (CC BY 4.0): https://sketchfab.com/3d-models/maple-tree-4b27adcf92f644bdabf8ecc6c5bef399
- Sky, HDRI and surface textures: Poly Haven (CC0), https://polyhaven.com
- The airfield, countryside, palms, people, vehicles, train and buildings of the town are generated in code
  (`tools/make_airfield.py` lays out the field, roads, town and villages; the palm is baked by `tools/bake_impostor.html`)

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

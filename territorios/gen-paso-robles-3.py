# -*- coding: utf-8 -*-
"""Paso Robles 3, tal como esta en la hoja de papel.

   Se genera con un script y no a mano porque son 61 domicilios: escribirlos
   uno por uno es como se cuelan los errores que despues mandan a alguien a
   tocar una puerta que no existe.

   Lo que dice la hoja, y como queda aqui:
     "1225- 1, 8-Vacio"        -> edificio 1225, deptos 1 y 8; el 8 vacio
     "(6- Expulsado)"          -> nota en ese depto
     "(5-No visitar 3/7/26)"   -> No visitar con su fecha
     "8-estudio de Hna Cruz"   -> nota
     "(1415 Posible Espanol)"  -> nota; sigue en la lista de español
     "(1307- No Visitar ...)"  -> No visitar, casa entera

   Los deptos que NO estan en la hoja se crean con idioma "Sin saber": son los
   del censo. Los ocho por edificio los confirmo el hermano.
"""
import io
import json

CIUDAD, ESTADO, ZIP = "Paso Robles", "CA", "93446"
TERR = "Paso Robles 3"
NUESTRO = "Español"
SIN_SABER = "Sin saber"

# La hoja esta fechada 6/16/26. Los "No visitar" sin fecha propia se quedan con
# esa, que es lo ultimo que se sabe de cierto.
FECHA_HOJA = "2026-06-16"

casas = []
_n = [0]


def add(calle, num, apt=None, idioma=NUESTRO, nota="", dnv=None):
    _n[0] += 1
    dir_ = "%s %s" % (num, calle) + (" #%s" % apt if apt else "")
    r = {
        "HouseAddress": dir_,
        "HouseCity": CIUDAD, "HouseState": ESTADO, "HouseZIP": ZIP,
        "HouseTerritoryNumber": TERR,
        "HouseLanguage": idioma,
        "HouseNotes": nota,
    }
    if dnv:
        r["dnv"] = {"reason": dnv[0], "date": dnv[1]}
    casas.append(r)


# ══ Stoney Creek Rd ══════════════════════════════════════════════════════
SC = "Stoney Creek Rd"

# Casas sueltas de la hoja. El 1131 aparecia dos veces: es un error, va una.
for num in ["905", "1129", "1131", "1332", "1339", "1409", "1430", "1440"]:
    add(SC, num)

add(SC, "1415", nota="Posible español")
add(SC, "1307", dnv=("Enviar ancianos", FECHA_HOJA))
add(SC, "1407", dnv=("Enviar ancianos", FECHA_HOJA))

# Los edificios: lo anotado en la hoja, y el resto para el censo.
EDIFICIOS = {
    "1225": {1: {}, 8: {"nota": "Vacío"}},
    "1227": {1: {}, 2: {}, 6: {"nota": "Expulsado"}, 8: {}},
    "1275": {4: {}, 5: {"dnv": ("Sin razón anotada", "2026-03-07")}, 8: {"nota": "Estudio de Hna. Cruz"}},
    "1277": {2: {}, 3: {"nota": "Visitar por la tarde"}, 4: {}, 6: {}},
    "1279": {4: {}, 5: {}},
}
DEPTOS_POR_EDIFICIO = 8

for num in sorted(EDIFICIOS):
    anotados = EDIFICIOS[num]
    for u in range(1, DEPTOS_POR_EDIFICIO + 1):
        if u in anotados:
            d = anotados[u]
            add(SC, num, apt=u, nota=d.get("nota", ""), dnv=d.get("dnv"))
        else:
            # Nunca se ha tocado: no se sabe quien vive ni que idioma habla.
            add(SC, num, apt=u, idioma=SIN_SABER)

# ══ Bel Air Pl ═══════════════════════════════════════════════════════════
for num in ["2173", "2178", "2192", "2196", "2197", "2198"]:
    add("Bel Air Pl", num)
add("Bel Air Pl", "2183", dnv=("Sin razón anotada", "2025-03-31"))

# ══ las dos calles cortas ════════════════════════════════════════════════
add("Saint Ann Dr", "913")
add("Saint Ann Dr", "915")
add("Sleepy Hollow Rd", "914")

# ── ordenar como se camina: por calle y por numero ───────────────────────
def clave(r):
    d = r["HouseAddress"]
    num = int(d.split(" ")[0])
    calle = d.split(" ", 1)[1].split(" #")[0]
    apt = int(d.split(" #")[1]) if " #" in d else 0
    return (calle, num, apt)


casas.sort(key=clave)

salida = {
    "territory": TERR,
    "city": CIUDAD, "state": ESTADO, "zip": ZIP,
    "source": "Hoja PR 3 Terr, fechada 6/16/26",
    "houses": casas,
}

io.open('territorios/paso-robles-3.json', 'w', encoding='utf-8', newline='').write(
    json.dumps(salida, ensure_ascii=False, indent=1))

nuestros = sum(1 for c in casas if c["HouseLanguage"] == NUESTRO)
censo = sum(1 for c in casas if c["HouseLanguage"] == SIN_SABER)
dnvs = sum(1 for c in casas if "dnv" in c)
notas = sum(1 for c in casas if c["HouseNotes"])
print("%d domicilios: %d en español, %d para el censo" % (len(casas), nuestros, censo))
print("%d No visitar, %d con nota" % (dnvs, notas))

# -*- coding: utf-8 -*-
"""Atascadero 4, tal como esta en la hoja (que viene rotulada "A4 1").

   Lo que dice la hoja y como queda aqui:
     "(8055 NO Visitar 1/4/24)"   -> No visitar, con su fecha
     "9465 (carta)"               -> nota: se le escribe
     "9460-A (posible español)"   -> el guion es el departamento: #A
     "8396 (Estudiante)"          -> nota
     "8437 (solo por carta)"      -> nota
     "(7905 Atras de Restaurante" -> nota; el parentesis aqui solo agrupa,
                                     no es un No visitar (va en negro)
     "Colorado Rd. (Fuera del..)" -> la nota es de la CALLE, se copia al
                                     domicilio que hay en ella
     "Los Altos Rd. (Rural)"      -> igual, a sus dos domicilios

   Todos en español: son los que el hermano tiene anotados como tales. El
   "posible español" se queda en la lista con su nota, para confirmarlo.
"""
import io
import json

CIUDAD, ESTADO, ZIP = "Atascadero", "CA", "93422"
TERR = "Atascadero 4"

casas = []


def add(calle, num, apt=None, nota="", dnv=None):
    dir_ = "%s %s" % (num, calle) + (" #%s" % apt if apt else "")
    r = {
        "HouseAddress": dir_,
        "HouseCity": CIUDAD, "HouseState": ESTADO, "HouseZIP": ZIP,
        "HouseTerritoryNumber": TERR,
        "HouseLanguage": "Español",
        "HouseNotes": nota,
    }
    if dnv:
        r["dnv"] = {"reason": dnv[0], "date": dnv[1]}
    casas.append(r)


add("San Andres Ave", "8550")
add("San Andres Ave", "8555")

add("Coromar Ave", "8055", dnv=("Sin razón anotada", "2024-01-04"))

add("Cason St", "8965")
add("Cason St", "8980")

add("Portola Rd", "8600", dnv=("Sin razón anotada", "2018-07-23"))

add("El Parque Ave", "9465", nota="Carta")
add("El Parque Ave", "9460", apt="A", nota="Posible español")

add("Curbaril Ave", "8396", nota="Estudiante")
add("Curbaril Ave", "8437", nota="Solo por carta")

add("Morro Rd", "7905", nota="Atrás del restaurante Malus Kitchen")
add("Morro Rd", "7850")

add("Azucena Ave", "8045")

add("Atascadero Ave", "7255")
add("Atascadero Ave", "7420")

# La nota de la calle baja al domicilio: en la app no hay donde poner una
# nota de calle, y perderla seria perder lo unico que avisa que este queda
# fuera de lo marcado en el mapa.
add("Colorado Rd", "10820", nota="Fuera del área marcada en el mapa")

add("Los Altos Rd", "13925", nota="Rural")
add("Los Altos Rd", "13841", nota="Rural")


def clave(r):
    d = r["HouseAddress"]
    num = int(d.split(" ")[0])
    calle = d.split(" ", 1)[1].split(" #")[0]
    apt = d.split(" #")[1] if " #" in d else ""
    return (calle, num, apt)


casas.sort(key=clave)

salida = {
    "territory": TERR,
    "city": CIUDAD, "state": ESTADO, "zip": ZIP,
    "source": "Hoja A4 1 — Atascadero #4",
    "houses": casas,
}
io.open('territorios/atascadero-a4.json', 'w', encoding='utf-8', newline='').write(
    json.dumps(salida, ensure_ascii=False, indent=1))

dnvs = sum(1 for c in casas if "dnv" in c)
notas = sum(1 for c in casas if c["HouseNotes"])
calles = len(set(c["HouseAddress"].split(" ", 1)[1].split(" #")[0] for c in casas))
print("%d domicilios en %d calles" % (len(casas), calles))
print("%d No visitar, %d con nota" % (dnvs, notas))

# Territorios preparados

Cada hoja de papel se convierte en un archivo `.json` que el administrador
importa desde **Opciones → Importar territorio**. La app enseña qué va a crear
antes de crear nada, y no duplica lo que ya exista.

## Por qué hay un script por territorio

Los `gen-*.py` son los que escriben cada `.json`. Existen porque un territorio
son decenas de domicilios y escribirlos a mano es como se cuelan los errores
que después mandan a alguien a tocar una puerta que no existe. El script deja
ver de un vistazo qué dice la hoja y en qué se convirtió.

Para cambiar algo —el número de departamentos de un edificio, una nota mal
copiada— se edita el script y se vuelve a correr desde la raíz del proyecto:

    python territorios/gen-atascadero-a4.py

## Qué revisa la prueba

`test/test-censo.js` recorre **todo** lo que esté en `index.json`, así que un
territorio nuevo queda revisado sin que nadie tenga que acordarse de añadirlo:
que ninguna dirección venga vacía ni repetida, que todas empiecen por su
número, que lleven código postal de cinco dígitos, ciudad, estado e idioma, y
que cada «No visitar» traiga razón y una fecha que no sea del futuro.

## Al agregar un territorio

1. Escribe su `gen-*.py` y córrelo.
2. Añádelo a `index.json`.
3. Corre `node test/test-censo.js`.

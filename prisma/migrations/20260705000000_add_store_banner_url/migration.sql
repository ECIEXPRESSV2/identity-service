-- Banner de la tienda: se guarda la URL pública del blob (stores/<id>/banner/imagen.png).
-- Antes el banner se leía por convención de nombre; ahora se persiste como el logo (imageUrl).
ALTER TABLE "stores" ADD COLUMN "bannerUrl" TEXT;

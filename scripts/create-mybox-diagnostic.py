"""Generate a clearly labelled synthetic connection-test image, never a field visit."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

out = Path(__file__).resolve().parents[1] / 'photo-backend' / 'assets' / 'mybox-connection-test.jpg'
out.parent.mkdir(exist_ok=True)
image = Image.new('RGB', (640, 240), '#244b43')
draw = ImageDraw.Draw(image)
font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 26)
draw.text((24, 48), 'MYBOX CONNECTION TEST', fill='white', font=font)
draw.text((24, 108), 'NOT A FIELD VISIT', fill='white', font=font)
image.save(out, format='JPEG', quality=70)
print(f'Test-only fixture generated: {out.stat().st_size} bytes')

"""Synthetic UI fixture, never upload as an actual site visit."""
import sys
from PIL import Image, ImageDraw, ImageFont

image = Image.effect_noise((3000, 2000), 36).convert('RGB')
draw = ImageDraw.Draw(image)
draw.rectangle((350, 350, 2650, 1700), fill='#dee7df', outline='#204e45', width=30)
draw.rectangle((1050, 700, 1950, 1700), fill='#42635e')
draw.rectangle((200, 100, 2800, 330), fill='#173e36')
try:
    font = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 100)
except OSError:
    font = ImageFont.load_default(size=100)
draw.text((300, 140), 'TEST ONLY - NOT A VISIT', font=font, fill='white')
draw.rectangle((0, 1750, 3000, 2000), fill='black')
draw.text((120, 1800), '2026-10-15 12:34 / ' + (sys.argv[2] if len(sys.argv) > 2 else 'SAMPLE'), font=font, fill='white')
image.save(sys.argv[1], 'JPEG', quality=97)
print(sys.argv[1])

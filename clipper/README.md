# Preme clipper pipeline

Semi-automatic clipping for the Preme x Deen x AB Livestream campaign. The tool
finds candidate moments, renders them to 9:16 with captions and the watermark,
and checks the campaign rules. You make the final picks.

## One-time setup

```bash
pip install -r requirements.txt
```

1. Put the Preme watermark PNG at `clipper/assets/watermark.png`. Use the file
   from the campaign's Drive link. A transparent background works best.
2. Check `config.json` against the campaign Guidelines doc. The watermark sits
   at 12% from the top, centered, which keeps it off the edges.

## Workflow

```bash
python pipeline.py download                # VOD -> work/source.mp4 (needs kick.com access)
python pipeline.py transcribe              # optional: captions and keyword scoring
python pipeline.py candidates --n 15       # -> work/candidates.csv
# open work/candidates.csv, watch each moment, set approved=yes,
# and write title + post_caption (caption must mention Preme, no "Drake")
python pipeline.py cut                     # approved rows -> out/<id>.mp4
python pipeline.py check                   # caption and render rules
```

## Notes

- `candidates` scores 30-second windows by loudness, speech density and keyword
  hits. It surfaces moments to review, but it can't judge humor or context, so
  check the context of every clip before you approve it.
- Without `transcribe`, there are no captions and scoring uses audio only.
- `cut` uses a blurred-background "fit" layout so every guest stays in frame.
- The tool doesn't post anything. Upload the files yourself from your own accounts.

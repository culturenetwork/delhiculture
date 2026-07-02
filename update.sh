#!/bin/bash
export DELHICULTURE_SITE_DOCS=/home/ab/delhiculture/docs
cd /opt/delhiculture-engine || exit 1
source .venv/bin/activate
python main.py >> /home/ab/delhiculture/update.log 2>&1

#!/bin/bash

# Step 1: Remove anything in the backend/parser/raw_export/all folder
echo "Step 1: Clearing backend/parser/raw_export/all folder..."
rm -rf backend/parser/raw_export/all/*
if [ $? -eq 0 ]; then
    echo "✓ Successfully cleared backend/parser/raw_export/all folder"
else
    echo "✗ Failed to clear backend/parser/raw_export/all folder"
    exit 1
fi

# Step 2: Run the backend/parser/scripts/extract_all.sh script
echo ""
echo "Step 2: Running backend/parser/scripts/extract_all.sh..."
bash backend/parser/scripts/extract_all.sh
if [ $? -eq 0 ]; then
    echo "✓ Successfully completed extract_all.sh"
else
    echo "✗ Failed to run extract_all.sh"
    exit 1
fi

# Step 3: Remove anything in the backend/storage/data folder
echo ""
echo "Step 3: Clearing backend/storage/data folder..."
rm -rf backend/storage/data/*
if [ $? -eq 0 ]; then
    echo "✓ Successfully cleared backend/storage/data folder"
else
    echo "✗ Failed to clear backend/storage/data folder"
    exit 1
fi

# Step 4: Run backend/run_parser.py file
echo ""
echo "Step 4: Running backend/run_parser.py..."
python -m backend.run_parser
if [ $? -eq 0 ]; then
    echo "✓ Successfully completed run_parser.py"
else
    echo "✗ Failed to run run_parser.py"
    exit 1
fi

# Step 5: Print finished message
echo ""
echo "=========================================="
echo "✓ Finished extraction and parser!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "- To start the front end: run analytics/start_analysis.sh"
echo "- To start training the bot: (WIP)"
echo ""

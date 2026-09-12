from pathlib import Path
import argparse
import pandas as pd



def convert_to_muselsl(fname, outdir):
    # Extract EEG data from file
    df = pd.read_csv(fname)
    # Rename columns, Remove null values
    filtered = df.rename(columns = {'eeg_1':'TP9',
                       'eeg_2':'AF7',
                       'eeg_3':'AF8',
                       'eeg_4':'TP10'})[['timestamps', 'TP9', 'AF7', 'AF8', 'TP10']].dropna()
    filtered['Right AUX'] = 0.0
    print(filtered.head(), len(df), len(filtered))
    # TODO : Support ACC, PPG

    # Get absolute filename, create output directory if missing
    if not Path(outdir).exists():
        Path(outdir).mkdir(parents=True, exist_ok=True)
    outname = f'{outdir}/muselsl_{str(Path(fname).name)}'
    filtered.to_csv(outname)

if __name__=="__main__":
    parser = argparse.ArgumentParser("Location of input/output muse data, other parameters")
    parser.add_argument('-i','--input-path',default="./recordings",help="Location of csv file, or path to parent directory of csv files to convert")
    parser.add_argument('-o','--output-path',default="./converted",help="Location of output csv files. muselsl_ prefix added to filename")
    args = parser.parse_args()

    path = Path(args.input_path)

    csv_files = []
    if path.exists():
        if path.is_dir():
            csv_files = [str(filepath.absolute()) for filepath in path.rglob('*.csv')]
        elif path.is_file() and path.suffix == ".csv":
            csv_files = [str(path.absolute())]
            
    for f in csv_files:
        convert_to_muselsl(f, args.output_path)

